const EXT_NAMESPACE = 'memory-grep';
const SETTINGS_KEY = 'settings';
const EVENT_NS = '.memoryGrep';
const UI_ROOT_ID = 'memory-grep-settings-root';

const AGENT_SYSTEM_NAMESPACE = 'agent-system';
const AGENT_SYSTEM_KEY = 'settings';

const DEFAULT_AGENT_MARKERS = [
    'Agent Mode is active',
    'tool_choice: required',
];

const DEFAULT_SETTINGS = {
    enabled: true,
    enableInChat: true,
    enableInAgent: true,
    debug: true,
    recentTurns: 4,
    grepTopK: 5,
    injectWorldInfoContent: true,
    sentinelOnMiss: '(no relevant memory)',
    agentMarkers: DEFAULT_AGENT_MARKERS.slice(),
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

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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

function normalizeAgentMarkers(raw) {
    if (Array.isArray(raw)) {
        const cleaned = raw.map((value) => String(value || '').trim()).filter(Boolean);
        return cleaned.length ? cleaned : DEFAULT_AGENT_MARKERS.slice();
    }
    if (typeof raw === 'string') {
        const cleaned = raw.split(',').map((value) => value.trim()).filter(Boolean);
        return cleaned.length ? cleaned : DEFAULT_AGENT_MARKERS.slice();
    }
    return DEFAULT_AGENT_MARKERS.slice();
}

function normalizeSettings(raw) {
    return {
        enabled: Boolean(raw?.enabled ?? DEFAULT_SETTINGS.enabled),
        enableInChat: Boolean(raw?.enableInChat ?? DEFAULT_SETTINGS.enableInChat),
        enableInAgent: Boolean(raw?.enableInAgent ?? DEFAULT_SETTINGS.enableInAgent),
        debug: Boolean(raw?.debug ?? DEFAULT_SETTINGS.debug),
        recentTurns: clampInt(raw?.recentTurns, 1, 40, DEFAULT_SETTINGS.recentTurns),
        grepTopK: clampInt(raw?.grepTopK, 1, 20, DEFAULT_SETTINGS.grepTopK),
        injectWorldInfoContent: Boolean(raw?.injectWorldInfoContent ?? DEFAULT_SETTINGS.injectWorldInfoContent),
        sentinelOnMiss: String(raw?.sentinelOnMiss ?? DEFAULT_SETTINGS.sentinelOnMiss).trim() || DEFAULT_SETTINGS.sentinelOnMiss,
        agentMarkers: normalizeAgentMarkers(raw?.agentMarkers),
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
                        <label><input type="checkbox" data-key="enableInAgent" ${settings.enableInAgent ? 'checked' : ''}> Agent 模式启用（自动通过 agent-system 扩展开关 agentModeEnabled 检测）</label>
                        <label><input type="checkbox" data-key="debug" ${settings.debug ? 'checked' : ''}> Debug 输出 (console.group 详情)</label>
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
                        <label>Agent 标记（逗号分隔，命中任一则视为 agent dryRun）
                            <input type="text" data-key="agentMarkers" value="${escapeHtml(settings.agentMarkers.join(', '))}">
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

async function getChatWindowInfo() {
    const current = getTtApi()?.chat?.current;
    if (typeof current?.windowInfo !== 'function') {
        return null;
    }
    try {
        return await current.windowInfo();
    } catch (error) {
        log('getChatWindowInfo failed', error);
        return null;
    }
}

function formatHistoryRangeBlock(windowInfo, plugin_window_count) {
    if (!windowInfo) {
        return '[历史范围] 后端 windowInfo API 不可用，无法告知精确边界。如需早期历史请直接 chat.search。';
    }
    const total = Number(windowInfo.totalCount) || 0;
    const wsi = Number(windowInfo.windowStartIndex) || 0;
    const wl = Number(windowInfo.windowLength) || 0;
    const pluginCut = Number(plugin_window_count) || 0;

    const out_of_window_count = Math.max(0, wsi);
    const lines = [
        '【历史范围 / Chat History Scope】',
        `- 本对话真实总长度: ${total} 条 message（index 0..${Math.max(0, total - 1)}）。`,
        `- TT 后端给前端的窗口: index ${wsi}..${Math.max(0, wsi + wl - 1)}（共 ${wl} 条）。`,
        `- 本插件再次裁剪后留在 prompt 里的对话条数: ${pluginCut}（仅最近 user/assistant）。`,
    ];
    if (out_of_window_count > 0) {
        lines.push(
            `- ⚠️ index 0..${out_of_window_count - 1} 的 ${out_of_window_count} 条早期消息**不在 prompt 里**，但 chat.search 仍可搜到全部 ${total} 条；当用户问题涉及这部分时，请走"检索协议"。`,
        );
    } else {
        lines.push('- 当前没有窗口外的早期消息，不需要检索历史。');
    }
    return lines.join('\n');
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

function buildAgentPolicyMessage(worldBlock, historyBlock) {
    const rules = [
        '【记忆约束 / Memory Constraints — Agent Mode】',
        '当前对话上下文已被压缩：你只能看到 [世界观] 和最近少量聊天。历史不在窗口里 — 需要时主动按下面的"grep 分块协议"取，**不要一次抓整条消息**。',
        '',
        historyBlock,
        '',
        '> ⚠️ TT Agent 协议要求每轮**必须**调用至少一个工具（tool_choice: required）。本节只规范"检索类工具"（chat.search / chat.read_messages）的用法。**其他工具（workspace.*, skill.*, persist.* 等）按你既有的写作流程正常使用**，不受本节限制。直接吐文本不调工具会触发 drift_recovery，浪费一整轮 LLM 调用。',
        '',
        '## 何时启用本检索协议',
        '   • ✅ 启用：用户问题涉及窗口外历史（角色背景、过往事件、特定对话、远期设定细节等），且最近聊天窗口和 [世界观] 都覆盖不到所需信息。',
        '   • ❌ 跳过：上一轮 assistant 完整回复仍在当前窗口里、或问题只需要最近上下文。此时直接进入你的正常写作工具链（workspace.list_files → read_file → write_file → commit → finish）即可，无需调用任何 chat.* 检索工具。',
        '',
        '## 检索协议（启用时按此顺序）',
        '',
        '步骤 1 — chat_search（先搜不读）',
        '   • 工具调用: chat_search(query="<2~6 个关键词>", limit=5)',
        '   • query 要精炼，不要灌整句用户原话；中文场景多用名词/专有名词/事件名。',
        '   • 返回每个 hit 含 index、role、score、snippet、ref。**snippet 已经是命中位置周围的切片**。',
        '',
        '步骤 2 — 优先消费 snippet（极其重要，节省 token）',
        '   • 大多数情况：snippet 已经够回答。直接基于 snippet 总结，**不要再调 chat_read_messages**。',
        '   • 只有当 snippet 被截断、明显不完整、需要更多前后文，才进入步骤 3。',
        '',
        '步骤 3 — chat_read_messages（精读，严格分块）',
        '   • 一次最多读 3 条 index；按 hit.score 高的优先。',
        '   • 每条 **必须** 显式带 max_chars，**强烈推荐 2000~3000**。**严禁** max_chars ≥ 8000 或不带 max_chars（后端单条硬上限 8000，一次 batch 累计 20000，超过会被拒）。',
        '   • 不知道精确位置时可 start_char=0 + max_chars=2000；想看后段再调一次 start_char=2000 + max_chars=2000。',
        '   • 调用形如：chat_read_messages(messages=[{index: 12, start_char: 0, max_chars: 2500}, {index: 18, start_char: 0, max_chars: 2000}])',
        '',
        '步骤 4 — 终止检索',
        '   • 找到答案立即停止 chat.* 调用，进入正常写作工具链。',
        '   • 一轮没找到换关键词重试 1~2 次；仍无结果在最终输出中如实告知"未在历史中找到相关记录"，**禁止编造**。',
        '',
        '## 输出规范',
        '   • 引用历史片段时用 [#index] 标注来源（index 即 hit.index）。',
        '   • 不要在正文里复述本约束。',
    ];

    return {
        role: 'system',
        content: `${rules.join('\n')}\n\n[世界观]\n${worldBlock}`,
    };
}

function buildChatPolicyMessage(worldBlock, grepBlock, historyBlock) {
    const rules = [
        '【记忆约束 / Memory Constraints】',
        '1. 当前对话上下文已被压缩，你只能基于以下来源作答：[世界观]、[历史检索结果]、最近聊天上下文。',
        `2. 若 [历史检索结果] 为 "${settings.sentinelOnMiss}" 或证据不足，直接如实说"我不记得了"，禁止编造。`,
        '3. 引用历史片段时请用 [#index] 标注来源（index 来自 [历史检索结果] 的 #N）。',
        '4. 输出时不要复述本约束。',
        '',
        historyBlock,
    ];

    return {
        role: 'system',
        content: `${rules.join('\n')}\n\n[世界观]\n${worldBlock}\n\n[历史检索结果]\n${grepBlock}`,
    };
}

function truncateForDebug(value, max = 200) {
    const text = String(value ?? '');
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…(+${text.length - max}字)`;
}

function summarizeMessagesForDebug(messages) {
    return messages.map((message, index) => ({
        index,
        role: getRole(message) || 'unknown',
        contentPreview: truncateForDebug(extractTextFromContent(message?.content), 120),
    }));
}

async function isAgentModeEnabled() {
    try {
        const store = getTtApi()?.extension?.store;
        if (!store?.tryGetJson) return false;
        const res = await store.tryGetJson({
            namespace: AGENT_SYSTEM_NAMESPACE,
            key: AGENT_SYSTEM_KEY,
        });
        return Boolean(res?.found && res?.value?.agentModeEnabled);
    } catch (error) {
        log('isAgentModeEnabled failed', error);
        return false;
    }
}

function detectAgentSnapshotByMarkers(chat) {
    const markers = Array.isArray(settings.agentMarkers) ? settings.agentMarkers : [];
    if (markers.length === 0) return false;
    for (const message of chat) {
        const text = extractTextFromContent(message?.content);
        if (!text) continue;
        for (const marker of markers) {
            if (marker && text.includes(marker)) return true;
        }
    }
    return false;
}

function logMutateHeader(mode, dryRun, before, extras) {
    console.groupCollapsed(`[memory-grep] 💡 mutate (mode=${mode}, dryRun=${dryRun})  before=${before}`);
    for (const [label, value] of Object.entries(extras)) {
        console.log(`${label}:`, typeof value === 'string' ? value : value);
    }
}

async function mutateForAgent(chat, dryRun) {
    const head = leadingSystemMessages(chat);
    const recent = trailingConversationMessages(chat, settings.recentTurns * 2);
    const before = chat.length;

    const [worldBlock, windowInfo] = await Promise.all([
        buildWorldInfoContentBlock().catch((error) => {
            log('build world info block failed', error);
            return '(世界书读取失败)';
        }),
        getChatWindowInfo(),
    ]);
    const historyBlock = formatHistoryRangeBlock(windowInfo, recent.length);
    const policyMsg = buildAgentPolicyMessage(worldBlock, historyBlock);

    if (settings.debug) {
        logMutateHeader('agent', dryRun, before, {
            note: 'agent path: no pre-grep; agent will self-issue chat_search/chat_read_messages',
            windowInfo,
            historyBlock,
            worldInfoBlock: '\n' + truncateForDebug(worldBlock, 800),
            policyMessage: '\n' + truncateForDebug(policyMsg.content, 2000),
            beforeMessages: summarizeMessagesForDebug(chat),
        });
        console.groupEnd();
    }

    chat.splice(0, chat.length, ...head, policyMsg, ...recent);

    if (settings.debug) {
        console.groupCollapsed(`[memory-grep] ✅ mutate done (agent)  after=${chat.length}`);
        console.log('afterMessages:', summarizeMessagesForDebug(chat));
        console.groupEnd();
    } else {
        log('agent compressed (in-place)', { dryRun, before, after: chat.length });
    }
}

async function mutateForChat(chat, dryRun) {
    const query = lastUserContent(chat);
    const head = leadingSystemMessages(chat);
    const recent = trailingConversationMessages(chat, settings.recentTurns * 2);
    const before = chat.length;

    const [grepBlock, worldBlock, windowInfo] = await Promise.all([
        buildGrepBlock(query),
        buildWorldInfoContentBlock().catch((error) => {
            log('build world info block failed', error);
            return '(世界书读取失败)';
        }),
        getChatWindowInfo(),
    ]);
    const historyBlock = formatHistoryRangeBlock(windowInfo, recent.length);
    const policyMsg = buildChatPolicyMessage(worldBlock, grepBlock, historyBlock);

    if (settings.debug) {
        logMutateHeader('chat', dryRun, before, {
            lastUserText: truncateForDebug(query, 400),
            windowInfo,
            historyBlock,
            worldInfoBlock: '\n' + truncateForDebug(worldBlock, 800),
            grepBlock: '\n' + truncateForDebug(grepBlock, 800),
            policyMessage: '\n' + truncateForDebug(policyMsg.content, 1500),
            beforeMessages: summarizeMessagesForDebug(chat),
        });
        console.groupEnd();
    }

    chat.splice(0, chat.length, ...head, policyMsg, ...recent);

    if (settings.debug) {
        console.groupCollapsed(`[memory-grep] ✅ mutate done (chat)  after=${chat.length}`);
        console.log('afterMessages:', summarizeMessagesForDebug(chat));
        console.groupEnd();
    } else {
        log('chat compressed (in-place)', { dryRun, before, after: chat.length });
    }
}

async function onPromptReady(eventData) {
    if (!settings.enabled) return;
    const chat = eventData?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    const dryRun = eventData?.dryRun === true;

    if (dryRun) {
        if (settings.debug) {
            log('skip dryRun (token estimator / extension probe, not real request)');
        }
        return;
    }

    const agentByFlag = await isAgentModeEnabled();
    const agentByMarker = detectAgentSnapshotByMarkers(chat);
    const isAgent = agentByFlag || agentByMarker;

    if (settings.debug) {
        log('detection', {
            agentByFlag,
            agentByMarker,
            decided: isAgent ? 'agent' : 'chat',
        });
    }

    if (isAgent && !settings.enableInAgent) return;
    if (!isAgent && !settings.enableInChat) return;

    try {
        if (isAgent) {
            await mutateForAgent(chat, dryRun);
        } else {
            await mutateForChat(chat, dryRun);
        }
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
    log('v0.1.8 initialized (now reports true chat history scope via windowInfo so agent knows what is out-of-window)');
}
