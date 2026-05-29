const EXT_NAMESPACE = 'memory-grep';
const SETTINGS_KEY = 'settings';
const EVENT_NS = '.memoryGrep';
const UI_ROOT_ID = 'memory-grep-settings-root';

const DEFAULT_SETTINGS = {
    enabled: true,
    enableInChat: true,
    enableInAgent: true,
    recentTurns: 4,
    grepTopK: 5,
    injectWorldInfoContent: true,
    sentinelOnMiss: '(no relevant memory)',
};

let settings = { ...DEFAULT_SETTINGS };
let initialized = false;
let worldInfoModulePromise = null;

function log(message, payload) {
    if (payload === undefined) {
        console.log(`[memory-grep] ${message}`);
        return;
    }
    console.log(`[memory-grep] ${message}`, payload);
}

function getStContext() {
    return window.SillyTavern?.getContext?.() ?? null;
}

function getTtApi() {
    return window.__TAURITAVERN__?.api ?? null;
}

function getSettingsContainer() {
    return $('#extensions_settings2, #extensions_settings').first();
}

function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(num)));
}

function normalizeSettings(raw) {
    return {
        enabled: Boolean(raw?.enabled ?? DEFAULT_SETTINGS.enabled),
        enableInChat: Boolean(raw?.enableInChat ?? DEFAULT_SETTINGS.enableInChat),
        enableInAgent: Boolean(raw?.enableInAgent ?? DEFAULT_SETTINGS.enableInAgent),
        recentTurns: clampInt(raw?.recentTurns, 1, 40, DEFAULT_SETTINGS.recentTurns),
        grepTopK: clampInt(raw?.grepTopK, 1, 20, DEFAULT_SETTINGS.grepTopK),
        injectWorldInfoContent: Boolean(raw?.injectWorldInfoContent ?? DEFAULT_SETTINGS.injectWorldInfoContent),
        sentinelOnMiss: String(raw?.sentinelOnMiss ?? DEFAULT_SETTINGS.sentinelOnMiss).trim() || DEFAULT_SETTINGS.sentinelOnMiss,
    };
}

async function loadSettings() {
    try {
        const store = getTtApi()?.extension?.store;
        if (!store?.tryGetJson) {
            settings = { ...DEFAULT_SETTINGS };
            return;
        }
        const saved = await store.tryGetJson({
            namespace: EXT_NAMESPACE,
            key: SETTINGS_KEY,
        });
        settings = normalizeSettings(saved);
    } catch (error) {
        log('load settings failed, using defaults', error);
        settings = { ...DEFAULT_SETTINGS };
    }
}

async function saveSettings() {
    settings = normalizeSettings(settings);
    try {
        const store = getTtApi()?.extension?.store;
        if (!store?.setJson) return;
        await store.setJson({
            namespace: EXT_NAMESPACE,
            key: SETTINGS_KEY,
            value: settings,
        });
    } catch (error) {
        log('save settings failed', error);
    }
}

function renderSettingsUi() {
    return `
        <div id="${UI_ROOT_ID}" class="memory-grep-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Memory Grep</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <fieldset>
                        <label><input type="checkbox" data-key="enabled" ${settings.enabled ? 'checked' : ''}> 启用插件</label>
                        <label><input type="checkbox" data-key="enableInChat" ${settings.enableInChat ? 'checked' : ''}> 普通聊天启用</label>
                        <label><input type="checkbox" data-key="enableInAgent" ${settings.enableInAgent ? 'checked' : ''}> Agent 模式启用</label>
                    </fieldset>
                    <fieldset>
                        <label>保留最近轮数
                            <input type="number" min="1" max="40" data-key="recentTurns" value="${settings.recentTurns}">
                        </label>
                        <label>历史检索 TopK
                            <input type="number" min="1" max="20" data-key="grepTopK" value="${settings.grepTopK}">
                        </label>
                        <label><input type="checkbox" data-key="injectWorldInfoContent" ${settings.injectWorldInfoContent ? 'checked' : ''}> 注入世界书正文（否则只注入目录）</label>
                        <label>未命中占位文案
                            <input type="text" data-key="sentinelOnMiss" value="${escapeHtml(settings.sentinelOnMiss)}">
                        </label>
                    </fieldset>
                </div>
            </div>
        </div>
    `;
}

function mountSettingsUi() {
    const container = getSettingsContainer();
    if (!container.length) {
        log('settings container not found');
        return;
    }

    $(`#${UI_ROOT_ID}`).remove();
    container.append(renderSettingsUi());

    const root = $(`#${UI_ROOT_ID}`);
    root.off(EVENT_NS).on(`input${EVENT_NS} change${EVENT_NS}`, 'input', async (event) => {
        const input = /** @type {HTMLInputElement} */ (event.currentTarget);
        const key = String(input.dataset.key || '').trim();
        if (!key) return;

        if (input.type === 'checkbox') {
            settings[key] = input.checked;
        } else if (input.type === 'number') {
            settings[key] = Number(input.value);
        } else {
            settings[key] = input.value;
        }

        settings = normalizeSettings(settings);
        await saveSettings();
    });
}

function getRole(message) {
    return String(message?.role || '').toLowerCase();
}

function extractTextFromContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part?.type === 'text' && typeof part?.text === 'string') return part.text;
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

function lastUserContent(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (getRole(chat[i]) === 'user') {
            return extractTextFromContent(chat[i]?.content).trim();
        }
    }
    return '';
}

function leadingSystemMessages(chat) {
    const result = [];
    for (const message of chat) {
        if (getRole(message) !== 'system') break;
        result.push(message);
    }
    return result;
}

function trailingConversationMessages(chat, maxItems) {
    const pool = chat.filter((message) => {
        const role = getRole(message);
        return role === 'user' || role === 'assistant';
    });
    return maxItems > 0 ? pool.slice(-maxItems) : pool;
}

async function getChatSearchHits(query) {
    const handle = getTtApi()?.chat?.current?.handle?.();
    if (!handle?.searchMessages) {
        return [];
    }
    return handle.searchMessages({
        query,
        limit: settings.grepTopK,
    });
}

async function buildGrepBlock(query) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return settings.sentinelOnMiss;

    try {
        const hits = await getChatSearchHits(trimmed);
        if (!Array.isArray(hits) || hits.length === 0) {
            return settings.sentinelOnMiss;
        }
        return hits
            .map((hit) => {
                const index = Number.isFinite(hit?.index) ? hit.index : '?';
                const score = Number.isFinite(hit?.score) ? Number(hit.score).toFixed(2) : '?';
                const snippet = String(hit?.snippet || hit?.text || '').replace(/\s+/g, ' ').trim();
                return `[#${index}|${score}] ${snippet}`;
            })
            .join('\n');
    } catch (error) {
        log('grep search failed', error);
        return settings.sentinelOnMiss;
    }
}

async function getWorldInfoModule() {
    if (!worldInfoModulePromise) {
        worldInfoModulePromise = import('/scripts/world-info.js');
    }
    return worldInfoModulePromise;
}

async function tryLoadWorldInfo(worldName) {
    try {
        const mod = await getWorldInfoModule();
        if (typeof mod?.loadWorldInfo !== 'function') return null;
        return await mod.loadWorldInfo(worldName);
    } catch (error) {
        log(`loadWorldInfo failed for "${worldName}"`, error);
        return null;
    }
}

function extractEntryContentFromWorld(worldData, uid) {
    const entries = worldData?.entries;
    if (!entries) return '';

    if (Array.isArray(entries)) {
        const item = entries.find((entry) => String(entry?.uid ?? '') === String(uid));
        return String(item?.content || '');
    }

    if (typeof entries === 'object') {
        const item = entries[String(uid)];
        return String(item?.content || '');
    }

    return '';
}

async function buildWorldInfoContentBlock() {
    const activation = await getTtApi()?.worldInfo?.getLastActivation?.();
    const entries = Array.isArray(activation?.entries) ? activation.entries : [];
    if (entries.length === 0) return '(无激活世界书)';

    if (!settings.injectWorldInfoContent) {
        return entries
            .map((entry) => `- [${entry?.world || 'unknown'}] ${entry?.displayName || entry?.uid || 'unnamed'}`)
            .join('\n');
    }

    const worldCache = new Map();
    const blocks = [];
    for (const entry of entries) {
        const worldName = String(entry?.world || '').trim();
        const uid = entry?.uid;
        const title = String(entry?.displayName || uid || 'unnamed').trim();

        let fullContent = '';
        if (worldName) {
            if (!worldCache.has(worldName)) {
                worldCache.set(worldName, await tryLoadWorldInfo(worldName));
            }
            fullContent = extractEntryContentFromWorld(worldCache.get(worldName), uid);
        }

        const content = String(fullContent || entry?.content || '').trim() || '(空内容)';
        blocks.push(`- [${worldName || 'unknown'} / ${title}] ${content}`);
    }

    return blocks.join('\n');
}

function buildPolicyMessage(mode, worldBlock, grepBlock) {
    const header = mode === 'agent'
        ? '【记忆约束 / Memory Constraints — Agent Mode】'
        : '【记忆约束 / Memory Constraints】';

    const modeRules = mode === 'agent'
        ? [
            '1. 当前上下文是窗口化的，只能基于以下来源回答：[世界观]、[历史检索结果]、最近聊天上下文。',
            `2. 若 [历史检索结果] 为 "${settings.sentinelOnMiss}" 或证据不足，必须先调用 chat_search / chat_read_messages，再作答。`,
            '3. 工具未命中时必须明确说“找不到相关记录”，禁止编造。',
        ]
        : [
            '1. 只能基于以下来源回答：[世界观]、[历史检索结果]、最近聊天上下文。',
            `2. 若 [历史检索结果] 为 "${settings.sentinelOnMiss}" 或证据不足，直接说“我不记得了”，禁止编造。`,
            '3. 引用历史时使用 [#index] 标注来源。',
        ];

    return {
        role: 'system',
        content: `${header}\n${modeRules.join('\n')}\n\n[世界观]\n${worldBlock}\n\n[历史检索结果]\n${grepBlock}`,
    };
}

async function mutateChatInPlace(chat, mode) {
    const query = lastUserContent(chat);
    const [grepBlock, worldBlock] = await Promise.all([
        buildGrepBlock(query),
        buildWorldInfoContentBlock().catch((error) => {
            log('build world info block failed', error);
            return '(世界书读取失败)';
        }),
    ]);

    const policyMsg = buildPolicyMessage(mode, worldBlock, grepBlock);
    const head = leadingSystemMessages(chat);
    const recent = trailingConversationMessages(chat, settings.recentTurns * 2);

    const before = chat.length;
    chat.splice(0, chat.length, ...head, policyMsg, ...recent);
    log(`${mode} mode compressed (in-place)`, { before, after: chat.length });
}

async function onPromptReady(eventData) {
    if (!settings.enabled) return;
    const chat = eventData?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    const isAgent = eventData?.dryRun === true;
    if (isAgent && !settings.enableInAgent) return;
    if (!isAgent && !settings.enableInChat) return;

    try {
        await mutateChatInPlace(chat, isAgent ? 'agent' : 'chat');
    } catch (error) {
        log('prompt mutation failed', error);
    }
}

export async function init() {
    if (initialized) return;
    initialized = true;

    await loadSettings();
    mountSettingsUi();

    const context = getStContext();
    const eventSource = context?.eventSource;
    const eventTypes = context?.event_types;
    if (!eventSource || !eventTypes?.CHAT_COMPLETION_PROMPT_READY) {
        log('event bus unavailable, skip listener registration');
        return;
    }

    if (typeof eventSource.removeListener === 'function') {
        eventSource.removeListener(eventTypes.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    }
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    log('initialized');
}
