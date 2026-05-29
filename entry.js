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
    const PLUGIN_VERSION = '0.1.19';
    const toggle = (key, text, hint = '') => `
        <label class="mg-toggle">
            <input type="checkbox" data-key="${key}" ${settings[key] ? 'checked' : ''}>
            <span class="mg-toggle-track"><span class="mg-toggle-thumb"></span></span>
            <span class="mg-toggle-text">${text}${hint ? ` <small>${hint}</small>` : ''}</span>
        </label>
    `;
    const stepper = (key, min, max) => `
        <div class="mg-number-stepper">
            <button type="button" class="mg-stepper-btn" data-step="-1" data-target="${key}" aria-label="−">−</button>
            <input type="number" class="text_pole" min="${min}" max="${max}" data-key="${key}" value="${settings[key]}">
            <button type="button" class="mg-stepper-btn" data-step="1" data-target="${key}" aria-label="＋">＋</button>
        </div>
    `;
    return `
        <div id="${UI_ROOT_ID}" class="mg-root">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-database"></i> Memory Grep <span class="mg-version">v${PLUGIN_VERSION}</span></b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content mg-content">
                    <p class="mg-tagline">
                        <i class="fa-solid fa-bolt"></i>
                        动态压缩 prompt，把窗口外历史按需 grep 注入 — 保留最近 N 轮真实对话，character preset 单独保留不占配额。
                    </p>

                    <section class="mg-section">
                        <header class="mg-section-title">
                            <i class="fa-solid fa-toggle-on"></i>
                            <h4>启用范围</h4>
                        </header>
                        <div class="mg-toggle-list">
                            ${toggle('enabled', '启用插件')}
                            ${toggle('enableInChat', '普通聊天启用')}
                            ${toggle('enableInAgent', 'Agent 模式启用', '(agent-system 扩展开关自动检测)')}
                            ${toggle('debug', 'Debug 输出', '(F12 console.group 详情)')}
                        </div>
                    </section>

                    <section class="mg-section">
                        <header class="mg-section-title">
                            <i class="fa-solid fa-sliders"></i>
                            <h4>检索参数</h4>
                        </header>
                        <div class="mg-form-grid">
                            <div class="mg-field">
                                <span class="mg-field-label">保留最近轮数</span>
                                <span class="mg-field-hint">user/assistant turn 数，最终保留 N×2 条对话</span>
                                ${stepper('recentTurns', 1, 40)}
                            </div>
                            <div class="mg-field">
                                <span class="mg-field-label">历史检索 Top-K</span>
                                <span class="mg-field-hint">chat.search 候选数，过滤后取前 3 注入</span>
                                ${stepper('grepTopK', 1, 20)}
                            </div>
                        </div>
                        <div class="mg-divider"></div>
                        ${toggle('injectWorldInfoContent', '注入世界书正文', '(否则只注入条目名)')}
                    </section>

                    <section class="mg-section">
                        <header class="mg-section-title">
                            <i class="fa-solid fa-pen-to-square"></i>
                            <h4>文本设定</h4>
                        </header>
                        <div class="mg-field">
                            <span class="mg-field-label">未命中占位文案</span>
                            <span class="mg-field-hint">Chat Mode pre-grep 无结果时显示</span>
                            <input type="text" class="text_pole mg-text" data-key="sentinelOnMiss" value="${escapeHtml(settings.sentinelOnMiss)}">
                        </div>
                        <div class="mg-field">
                            <span class="mg-field-label">Agent 标记词</span>
                            <span class="mg-field-hint">逗号分隔，命中任一视为 agent (fallback 检测)</span>
                            <input type="text" class="text_pole mg-text" data-key="agentMarkers" value="${escapeHtml(settings.agentMarkers.join(', '))}">
                        </div>
                    </section>

                    <footer class="mg-footer">
                        <a href="https://github.com/yhny1001/memory-grep" target="_blank" rel="noopener">
                            <i class="fa-brands fa-github"></i> yhny1001/memory-grep
                        </a>
                    </footer>
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

    root.on(`click${EVENT_NS}`, '.mg-stepper-btn', async (event) => {
        const btn = /** @type {HTMLButtonElement} */ (event.currentTarget);
        const target = String(btn.dataset.target || '').trim();
        const step = Number(btn.dataset.step) || 0;
        if (!target || !step) return;
        const input = /** @type {HTMLInputElement | null} */ (root.find(`input[data-key="${target}"]`)[0]);
        if (!input) return;
        const min = Number(input.min);
        const max = Number(input.max);
        const next = Number(input.value || 0) + step;
        const clamped = Math.max(
            Number.isFinite(min) ? min : -Infinity,
            Math.min(Number.isFinite(max) ? max : Infinity, next),
        );
        input.value = String(clamped);
        // 触发原有 input handler 完成持久化
        input.dispatchEvent(new Event('input', { bubbles: true }));
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

const PRESET_TAG_RE = /^<(overall-rules|writing-guidelines|rear-functions|now-player-input|system|chat-history|world-info|character-description|character-personality|scenario|persona|jailbreak)\b/i;
const PRESET_BRACKET_RE = /^[【〖][^】〗]{0,40}(要求|规则|约束|准则|模式|功能|说明|提示|纲要|指令)[】〗]/;

function isLikelyPresetUser(message) {
    if (getRole(message) !== 'user') return false;
    const text = extractTextFromContent(message?.content).trim();
    if (!text) return false;
    // XML tag 包裹（含 ST 注入的 <now-player-input>）/ 中文 bracket 是 preset 的强信号，不论长短
    if (PRESET_TAG_RE.test(text)) return true;
    if (PRESET_BRACKET_RE.test(text)) return true;
    // 兜底启发式：role=user 但内容很长（>1500 字），几乎肯定是 character preset / jailbreak / system-as-user
    if (text.length > 1500) return true;
    return false;
}

/**
 * 把 chat 中除 leading systems 之外的部分拆成
 *  - realDialog: 真实对话历史（user/assistant，按原顺序）
 *  - presetBlock: 被识别为 character preset / jailbreak / 长系统提示的 user 消息（按原顺序）
 *
 * 真实对话只取最后 maxRealItems 条；preset block 全部保留（不占 maxRealItems 配额）。
 * 返回 [...recentRealDialog, ...presetBlock]，保持 preset 在末尾的常规 OAI 顺序。
 */
function partitionConversation(chat, headCount, maxRealItems) {
    const body = chat.slice(headCount);
    const realDialog = [];
    const presetBlock = [];
    for (const message of body) {
        const role = getRole(message);
        if (role !== 'user' && role !== 'assistant') continue;
        if (isLikelyPresetUser(message)) {
            presetBlock.push(message);
        } else {
            realDialog.push(message);
        }
    }
    const recentReal = maxRealItems > 0 ? realDialog.slice(-maxRealItems) : realDialog;
    return {
        recentReal,
        presetBlock,
        realDialogTotal: realDialog.length,
        presetTotal: presetBlock.length,
    };
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
        return '【历史范围】后端 windowInfo API 不可用，无法告知精确边界。如需早期历史请直接 chat.search。';
    }
    const total = Number(windowInfo.totalCount) || 0;
    const wsi = Number(windowInfo.windowStartIndex) || 0;
    const wl = Number(windowInfo.windowLength) || 0;
    const pluginCut = Number(plugin_window_count) || 0;

    // 真正可见给 agent 的是「plugin 砍完之后」剩下的 pluginCut 条，
    // 这些是来自 TT 提供窗口 [wsi..wsi+wl-1] 的尾部 pluginCut 条。
    const agent_first_visible_index = Math.max(0, total - pluginCut);
    const out_of_window_count = agent_first_visible_index;

    const lines = [
        '【历史范围 / Chat History Scope】',
        `- 本对话真实总长度: ${total} 条 message（index 0..${Math.max(0, total - 1)}）。`,
        `- TT 后端给前端的窗口: index ${wsi}..${Math.max(0, wsi + wl - 1)}（共 ${wl} 条）。`,
        `- 本插件最终留给你的对话窗口: index ${agent_first_visible_index}..${Math.max(0, total - 1)}（共 ${pluginCut} 条 user/assistant）。`,
    ];
    if (out_of_window_count > 0) {
        lines.push(
            `- ⚠️ index 0..${out_of_window_count - 1} 的 ${out_of_window_count} 条早期消息**不在你的 prompt 里**。chat.search 仍可搜到全部 ${total} 条；当用户问题可能涉及这部分时，请主动走"检索协议"。`,
        );
    } else {
        lines.push('- 当前所有历史都在窗口里，不需要检索。');
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

const MIN_QUERY_LEN_FOR_PREGREP = 5;

/**
 * Agent 模式下的"智能 pre-grep"：
 *  - 短输入（< MIN_QUERY_LEN_FOR_PREGREP）或 query 为空 → 返回 ''（不注入）
 *  - 用 lastUserContent 做 chat.search 拿 top-K hits
 *  - 过滤掉已经在 prompt 窗口里的 hit（避免重复消耗 token）
 *  - 返回 [早期相关片段] block；为空（如所有 hit 都在窗口里 / 真没匹配）也返回 ''
 *
 * 设计目的：不强制 LLM 调用 chat.search，但保证当用户连续追写剧情时 agent 一定看得到早期关键片段；
 *           LLM 可以基于 snippet 直接用，需要更长上下文时再自行 chat_read_messages 取完整段。
 */
async function buildEarlyContextBlock(query, windowInfo, recentRealCount) {
    const trimmed = String(query || '').trim();
    if (trimmed.length < MIN_QUERY_LEN_FOR_PREGREP) {
        return ''; // hi / 嗯 / 输出 等短反馈不触发 pre-grep
    }
    if (!windowInfo) return '';
    const total = Number(windowInfo.totalCount) || 0;
    const visibleStart = Math.max(0, total - Number(recentRealCount || 0));
    if (visibleStart === 0) return ''; // 全部历史都在窗口里，不需要早期片段

    let hits;
    try {
        hits = await getChatSearchHits(trimmed);
    } catch (error) {
        log('pre-grep failed', error);
        return '';
    }
    if (!Array.isArray(hits) || hits.length === 0) return '';

    // 只保留 out-of-window 的 hit
    const outOfWindowHits = hits.filter((h) => {
        const idx = Number(h?.index);
        return Number.isFinite(idx) && idx < visibleStart;
    });
    if (outOfWindowHits.length === 0) return '';

    const top = outOfWindowHits.slice(0, 3);
    const lines = [
        '【早期相关片段 / Early Context Snippets — plugin pre-grep】',
        `针对用户当前输入「${trimmed.slice(0, 80)}」对窗口外 index 0..${visibleStart - 1} 做了 chat.search，命中片段（按 score 排序）：`,
    ];
    top.forEach((h, i) => {
        const idx = Number.isFinite(h?.index) ? h.index : '?';
        const role = h?.role || '?';
        const score = Number.isFinite(h?.score) ? Number(h.score).toFixed(3) : '?';
        const snippet = String(h?.snippet || h?.text || '').slice(0, 600);
        lines.push('');
        lines.push(`--- hit ${i + 1} | [#${idx}] role=${role} score=${score} ---`);
        lines.push(snippet);
    });
    lines.push('');
    lines.push(
        '> 这些 snippet 已是命中位置周围切片，**优先直接消费**；只有 snippet 明显不完整时再 chat_read_messages([{index:<#>,start_char:0,max_chars:2500}]) 取更长段。如果上面片段已够，无需再调 chat.* 工具。',
    );
    return lines.join('\n');
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

/**
 * 末尾 audit 引用规范（v0.1.15）：放在 chat 末尾，凌驾 preset 优先级。
 *  - 仅保留 [#index] 引用规范，让 audit 能直接看出 LLM 是否真的消费了 pre-grep 注入的 snippet
 *  - drift 防御已撤回（参见 v0.1.15 commit message），如果你不需要 audit 信号也可直接不调用此函数
 */
function buildHardRuleTail() {
    const content = [
        '【引用规范 / Citation Requirement — plugin audit signal】',
        '如果你在本轮正文里用到了 [早期相关片段 / Early Context Snippets] 中的任何信息（人物名、事件名、对话内容、世界观细节），必须在使用处用 [#X] 标记来源（X 即 hit.index）。',
        '只在正文 / details 中标，不要塞到格式规范字段里。',
        '没用 pre-grep 片段就不需要标。',
    ].join('\n');
    return { role: 'user', content };
}

function buildAgentPolicyMessage(worldBlock, historyBlock, earlyContextBlock = '') {
    const rules = [
        '【记忆约束 / Memory Constraints — Agent Mode】',
        '你的上下文已被 plugin 压缩。[历史范围] 告诉你哪些 message index 在窗口外；',
        'plugin 还自动用本轮用户输入跑了 chat.search，结果在 [早期相关片段]。',
        '',
        '* **优先消费 [早期相关片段] 的 snippet**，绝大多数任务都够用。',
        '* snippet 被截断 / 需要更长上下文：chat_read_messages([{index:<#>, start_char:0, max_chars:8000}])。',
        '  **单条 max_chars 硬上限 8000**（后端约束，超过会被拒），一批累计 ≤20000。',
        '* [早期相关片段] 没命中你要的：重新 chat_search(query="<2~6 关键词>", limit=5)。query 用名词/事件名，不要灌原话。',
        '* 历史里没有就如实说"未在历史中找到"，禁止编造。',
        '',
        historyBlock,
    ];

    const earlySection = earlyContextBlock
        ? `\n\n${earlyContextBlock}`
        : '';

    return {
        role: 'system',
        content: `${rules.join('\n')}${earlySection}\n\n[世界观]\n${worldBlock}`,
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
    const { recentReal, presetBlock, realDialogTotal, presetTotal } = partitionConversation(
        chat,
        head.length,
        settings.recentTurns * 2,
    );
    // ⚠️ 必须从 recentReal 取 query，不能从 chat 取
    // chat 末尾是 character preset 块（也是 role=user），lastUserContent(chat)
    // 会拿到「【思维模式要求】...」之类的 preset，导致 chat.search 用错关键词
    const query = lastUserContent(recentReal);
    const before = chat.length;

    const windowInfo = await getChatWindowInfo();
    const [worldBlock, earlyContextBlock] = await Promise.all([
        buildWorldInfoContentBlock().catch((error) => {
            log('build world info block failed', error);
            return '(世界书读取失败)';
        }),
        buildEarlyContextBlock(query, windowInfo, recentReal.length),
    ]);
    const historyBlock = formatHistoryRangeBlock(windowInfo, recentReal.length);
    const policyMsg = buildAgentPolicyMessage(worldBlock, historyBlock, earlyContextBlock);

    if (settings.debug) {
        logMutateHeader('agent', dryRun, before, {
            note: 'agent path: smart pre-grep on lastUserContent; agent may further chat_read_messages on demand',
            lastUserText: truncateForDebug(query, 200),
            windowInfo,
            partition: {
                head: head.length,
                realDialogTotal,
                recentRealKept: recentReal.length,
                presetTotal,
            },
            historyBlock,
            earlyContextBlock: earlyContextBlock
                ? '\n' + truncateForDebug(earlyContextBlock, 1200)
                : '(no pre-grep injection: query too short / no out-of-window hits)',
            worldInfoBlock: '\n' + truncateForDebug(worldBlock, 800),
            policyMessage: '\n' + truncateForDebug(policyMsg.content, 2500),
            beforeMessages: summarizeMessagesForDebug(chat),
        });
        console.groupEnd();
    }

    const hardRuleTail = buildHardRuleTail();
    chat.splice(0, chat.length, ...head, policyMsg, ...recentReal, ...presetBlock, hardRuleTail);

    if (settings.debug) {
        console.groupCollapsed(`[memory-grep] ✅ mutate done (agent)  after=${chat.length}`);
        console.log('afterMessages:', summarizeMessagesForDebug(chat));
        console.groupEnd();
    } else {
        log('agent compressed (in-place)', { dryRun, before, after: chat.length });
    }
}

async function mutateForChat(chat, dryRun) {
    const head = leadingSystemMessages(chat);
    const { recentReal, presetBlock, realDialogTotal, presetTotal } = partitionConversation(
        chat,
        head.length,
        settings.recentTurns * 2,
    );
    // ⚠️ 同 mutateForAgent，必须从 recentReal 取 query 避免被 preset 污染
    const query = lastUserContent(recentReal);
    const before = chat.length;

    const [grepBlock, worldBlock, windowInfo] = await Promise.all([
        buildGrepBlock(query),
        buildWorldInfoContentBlock().catch((error) => {
            log('build world info block failed', error);
            return '(世界书读取失败)';
        }),
        getChatWindowInfo(),
    ]);
    const historyBlock = formatHistoryRangeBlock(windowInfo, recentReal.length);
    const policyMsg = buildChatPolicyMessage(worldBlock, grepBlock, historyBlock);

    if (settings.debug) {
        logMutateHeader('chat', dryRun, before, {
            lastUserText: truncateForDebug(query, 400),
            windowInfo,
            partition: {
                head: head.length,
                realDialogTotal,
                recentRealKept: recentReal.length,
                presetTotal,
            },
            historyBlock,
            worldInfoBlock: '\n' + truncateForDebug(worldBlock, 800),
            grepBlock: '\n' + truncateForDebug(grepBlock, 800),
            policyMessage: '\n' + truncateForDebug(policyMsg.content, 1500),
            beforeMessages: summarizeMessagesForDebug(chat),
        });
        console.groupEnd();
    }

    chat.splice(0, chat.length, ...head, policyMsg, ...recentReal, ...presetBlock);

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
    log('v0.1.18 initialized (chat_read_messages max_chars aligned to backend hard limit 8000)');
}
