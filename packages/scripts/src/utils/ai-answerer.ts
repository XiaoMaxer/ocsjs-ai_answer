import type { AnswererWrapper, SearchInformation } from '@ocsjs/core';

/**
 * AI 搜题（大模型）核心模块。
 *
 * 设计目标：
 * - 与原有题库配置完全解耦：不改动 `answererWrappers` 的存储与解析逻辑，
 *   仅在 `getWorkOptions()` 时把 AI 配置转换成一个动态生成的 {@link AnswererWrapper} 追加到列表末尾，
 *   因此所有平台（cx / zhs / icve / icourse / yuketang …）的搜题流程、结果展示、缓存、
 *   答案匹配与降级逻辑全部复用，无需任何平台代码改动。
 * - 配置化：接口地址、API 密钥、模型、温度、最大回答长度、超时、请求方式、系统提示词均可配置，
 *   通过 OpenAI 兼容的 `/chat/completions` 协议支持 DeepSeek / OpenAI / 通义 / Kimi / Ollama / vLLM 等服务。
 * - 可降级：AI 请求失败时只影响 AI 这一路结果（错误信息展示在结果面板），
 *   其他题库与原有自动答题逻辑不受影响。
 */

/** AI 搜题在搜索结果中的展示名称 */
export const AI_SEARCH_ANSWERER_NAME = '🤖 AI 搜题';

/** 随机兜底结果在搜索结果中的展示名称 */
export const AI_RANDOM_FALLBACK_NAME = '🎲 随机兜底';

/**
 * 判断 AI 的回答是否为「无法确定」类回答。
 * 命中后禁止把该回答当作答案提交：优先使用题库答案，题库也无答案时才启用随机兜底。
 */
export function isAIUncertainAnswer(content: string): boolean {
	let text = String(content ?? '').trim();
	text = text.replace(/^答案\s*[:：]\s*/i, '').replace(/^AI\s*[:：]?\s*/i, '');
	text = text.replace(/[。.!！?？"'“”‘’\s]/g, '');
	return /^(无法确定|不确定|无法回答|无法判断|不能确定|不知道|未知|无答案|无法作答)$/i.test(text);
}

/** 随机兜底答案生成参数 */
export interface RandomFallbackAnswerOptions {
	/** 题目类型：single / multiple / judgement / completion */
	type?: string;
	/** 选项数量（填空题时为填空框数量） */
	optionCount: number;
	/** 填空题随机文案候选，默认使用内置文案 */
	completionTexts?: string[];
	/** 注入随机数生成器，便于单元测试（返回 [0, 1)） */
	random?: () => number;
}

/**
 * 生成随机兜底答案。
 * - 单选：随机选项字母；
 * - 多选：随机 1~N 个不重复选项字母，按字母顺序用 # 连接；
 * - 判断：随机「正确」或「错误」（可匹配任意对/错形式的选项）；
 * - 填空：随机文案按填空数量用 # 连接；
 * - 无选项或无法识别类型时返回 undefined，保持原行为（不提交）。
 */
export function createRandomFallbackAnswer(options: RandomFallbackAnswerOptions): string | undefined {
	const count = Math.max(0, Math.floor(Number(options.optionCount) || 0));
	const random = options.random ?? Math.random;
	const pick = (max: number) => Math.min(max - 1, Math.max(0, Math.floor(random() * max)));

	switch (options.type) {
		case 'single':
			return count > 0 ? String.fromCharCode(65 + pick(count)) : undefined;
		case 'multiple': {
			if (count <= 0) return undefined;
			const selected = 1 + pick(count);
			const pool = Array.from({ length: count }, (_, i) => i);
			// Fisher-Yates 洗牌后取前 selected 个，保证不重复
			for (let i = pool.length - 1; i > 0; i--) {
				const j = pick(i + 1);
				[pool[i], pool[j]] = [pool[j], pool[i]];
			}
			return pool
				.slice(0, selected)
				.sort((a, b) => a - b)
				.map((i) => String.fromCharCode(65 + i))
				.join('#');
		}
		case 'judgement':
			return random() < 0.5 ? '正确' : '错误';
		case 'completion': {
			let texts = (options.completionTexts ?? []).map((t) => String(t).trim()).filter(Boolean);
			if (!texts.length) texts = ['不会', '不知道', '不清楚', '不懂', '不会写'];
			const text = texts[pick(texts.length)];
			return Array(Math.max(1, count)).fill(text).join('#');
		}
		default:
			return count > 0 ? String.fromCharCode(65 + pick(count)) : undefined;
	}
}

/**
 * AI 无法确定答案时的兜底处理结果
 */
export interface AIUncertainFallbackResult {
	/** 是否使用了题库答案 */
	usedBank: boolean;
	/** 是否使用了随机兜底 */
	usedRandom: boolean;
	/** 随机兜底的答案（usedRandom 为 true 时有值） */
	randomAnswer?: string;
}

/**
 * AI 无法确定答案时执行兜底：
 * 1. 剔除 AI 的不确定回答，禁止其参与答案匹配与提交（尤其是填空题会被原样填入）；
 * 2. 题库存在有效答案时优先使用题库（题库条目本来就在 AI 之前，剔除 AI 后自然优先命中）；
 * 3. 题库也无答案时，按题目类型生成随机答案作为最后的兜底（可关闭）。
 *
 * @returns 兜底行为信息，供调用方展示用户提示
 */
export function applyAIUncertainFallback(
	searchInfos: SearchInformation[],
	options: {
		type?: string;
		title?: string;
		optionCount: number;
		completionTexts?: string[];
		/** 是否允许随机兜底 */
		enabled: boolean;
		/** 注入随机数生成器，便于测试 */
		random?: () => number;
	}
): AIUncertainFallbackResult {
	const isAIInfo = (info: SearchInformation) => info.name === AI_SEARCH_ANSWERER_NAME;
	const isUncertain = (result: { answer?: any; extra_data?: any }) =>
		result.extra_data?.uncertain === true || isAIUncertainAnswer(String(result.answer ?? ''));

	const uncertainInfos = searchInfos.filter(
		(info) => isAIInfo(info) && info.results?.some((result) => isUncertain(result))
	);
	if (!uncertainInfos.length) {
		return { usedBank: false, usedRandom: false };
	}

	const bankHasAnswer = searchInfos.some(
		(info) => !isAIInfo(info) && info.results?.some((result) => String(result.answer ?? '').trim().length > 0)
	);

	// 剔除不确定回答，避免其被解析器当作真实答案（填空题型会直接写入输入框）
	for (const info of uncertainInfos) {
		info.results = info.results.filter((result) => !isUncertain(result));
		info.error =
			'AI 无法确定该题答案' +
			(bankHasAnswer
				? '，已改用题库答案。'
				: options.enabled
				? '，题库也无答案，已启用随机答案兜底。'
				: '，题库也无答案，本题将留空不答。');
	}

	if (bankHasAnswer) {
		return { usedBank: true, usedRandom: false };
	}
	if (!options.enabled) {
		return { usedBank: false, usedRandom: false };
	}

	const randomAnswer = createRandomFallbackAnswer({
		type: options.type,
		optionCount: options.optionCount,
		completionTexts: options.completionTexts,
		random: options.random
	});
	if (!randomAnswer) {
		return { usedBank: false, usedRandom: false };
	}

	searchInfos.push({
		name: AI_RANDOM_FALLBACK_NAME,
		homepage: '#',
		url: '#',
		results: [
			{
				question: options.title ?? '',
				answer: randomAnswer,
				extra_data: { randomFallback: true }
			}
		]
	});

	return { usedBank: false, usedRandom: true, randomAnswer };
}

/** 默认系统提示词：要求模型只输出可直接用于选项匹配的最终答案 */
export const DEFAULT_AI_SYSTEM_PROMPT = [
	'你是一名严谨的网课答题助手。',
	'请根据题目与选项直接给出最终答案，不要输出解题过程、解释或多余文字。',
	'规则：',
	'1. 选择题只输出选项字母（如 A 或 A#C），多选题答案之间用 # 分隔；',
	'2. 判断题只输出「正确」或「错误」；',
	'3. 填空题按空的顺序输出答案，多个空用 # 分隔，不要带题号；',
	'4. 无法确定时输出「无法确定」。'
].join('\n');

/** AI 请求方式：GM 可绕过跨域（需要脚本 @connect 授权），fetch 需接口支持 CORS */
export type AIRequestType = 'GM_xmlhttpRequest' | 'fetch';

/** AI 搜题运行时配置（已归一化） */
export interface AISearchConfig {
	/** 总开关 */
	enable: boolean;
	/** OpenAI 兼容的 chat/completions 接口地址 */
	apiUrl: string;
	/** API 密钥（本地服务可留空） */
	apiKey: string;
	/** 模型名称 */
	model: string;
	/** 采样温度 0-2 */
	temperature: number;
	/** 最大回答长度（tokens） */
	maxTokens: number;
	/** 请求超时（秒） */
	timeoutSeconds: number;
	/** 请求方式 */
	requestType: AIRequestType;
	/** 系统提示词 */
	systemPrompt: string;
}

/** 默认值集中定义，便于测试与界面提示复用 */
export const AI_SEARCH_DEFAULTS = {
	temperature: 0.3,
	maxTokens: 1024,
	timeoutSeconds: 60,
	requestType: 'GM_xmlhttpRequest' as AIRequestType,
	systemPrompt: DEFAULT_AI_SYSTEM_PROMPT
};

/** 从全局设置 cfg 读取 AI 配置（键名与 common.ts 中的 config key 一一对应） */
export function readAISearchConfig(cfg: Record<string, any> | undefined): AISearchConfig {
	return normalizeAISearchConfig({
		enable: cfg?.aiSearchEnable,
		apiUrl: cfg?.aiSearchApiUrl,
		apiKey: cfg?.aiSearchApiKey,
		model: cfg?.aiSearchModel,
		temperature: cfg?.aiSearchTemperature,
		maxTokens: cfg?.aiSearchMaxTokens,
		timeoutSeconds: cfg?.aiSearchTimeout,
		requestType: cfg?.aiSearchRequestType,
		systemPrompt: cfg?.aiSearchSystemPrompt
	});
}

/** 数字归一化：非法值回退默认值并裁剪到 [min, max] */
function toClampedNumber(value: unknown, fallback: number, min: number, max: number, integer = false): number {
	const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
	if (typeof num !== 'number' || !Number.isFinite(num)) return fallback;
	const clamped = Math.min(max, Math.max(min, num));
	return integer ? Math.round(clamped) : clamped;
}

/** 去掉用户复制配置时可能带上的反引号、引号与首尾空白 */
function stripWrapperChars(value: unknown): string {
	return String(value ?? '')
		.trim()
		.replace(/^[`'"]+/, '')
		.replace(/[`'"]+$/, '')
		.trim();
}

/**
 * 接口地址归一化：
 * - 仅填域名或到 `/v1` 时自动补全 `/v1/chat/completions` 或 `/chat/completions`；
 * - 已包含 `chat/completions` 的完整地址（含 Azure 等自定义路径）原样保留。
 */
export function normalizeAISearchApiUrl(value: unknown): string {
	const raw = stripWrapperChars(value);
	if (!raw) return '';
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		// 非法地址原样返回，由 validateAISearchConfig 给出提示
		return raw;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;
	const path = url.pathname.replace(/\/+$/, '');
	if (/\/chat\/completions$/i.test(path)) {
		url.pathname = path;
		return url.toString();
	}
	if (path === '' || path === '/') {
		url.pathname = '/v1/chat/completions';
		return url.toString();
	}
	if (/\/v\d+$/i.test(path)) {
		url.pathname = path + '/chat/completions';
		return url.toString();
	}
	// 自定义路径（如反向代理、Azure 部署地址）保持原样
	url.pathname = path;
	return url.toString();
}

/**
 * 归一化配置：补全默认值、裁剪数值范围、清理字符串。
 * 幂等，可安全重复调用。
 */
export function normalizeAISearchConfig(raw?: Partial<AISearchConfig> & Record<string, any>): AISearchConfig {
	return {
		enable: raw?.enable === true,
		apiUrl: normalizeAISearchApiUrl(raw?.apiUrl),
		apiKey: stripWrapperChars(raw?.apiKey),
		model: stripWrapperChars(raw?.model),
		temperature: toClampedNumber(raw?.temperature, AI_SEARCH_DEFAULTS.temperature, 0, 2),
		maxTokens: toClampedNumber(raw?.maxTokens, AI_SEARCH_DEFAULTS.maxTokens, 1, 32768, true),
		timeoutSeconds: toClampedNumber(raw?.timeoutSeconds, AI_SEARCH_DEFAULTS.timeoutSeconds, 5, 600, true),
		requestType: raw?.requestType === 'fetch' ? 'fetch' : 'GM_xmlhttpRequest',
		systemPrompt: stripWrapperChars(raw?.systemPrompt) || DEFAULT_AI_SYSTEM_PROMPT
	};
}

/** 配置校验结果 */
export interface AISearchValidation {
	ok: boolean;
	errors: string[];
}

/**
 * 校验配置（与是否启用无关，便于「测试连接」在未开启时也能校验）。
 * API 密钥允许为空：Ollama / 本地 vLLM 等无需密钥。
 */
export function validateAISearchConfig(config: AISearchConfig): AISearchValidation {
	const errors: string[] = [];
	if (!config.apiUrl) {
		errors.push('请填写 AI 接口地址');
	} else {
		try {
			const url = new URL(config.apiUrl);
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {
				errors.push('AI 接口地址必须以 http:// 或 https:// 开头');
			}
		} catch {
			errors.push('AI 接口地址格式不正确');
		}
	}
	if (!config.model) {
		errors.push('请填写模型名称');
	}
	return { ok: errors.length === 0, errors };
}

/** 构造发给大模型的消息（与生成的 data.messages handler 保持同一逻辑，供测试与复用） */
export function buildAIMessages(
	config: AISearchConfig,
	env: { title?: string; options?: string; type?: string }
): Array<{ role: 'system' | 'user'; content: string }> {
	const type = env.type || 'unknown';
	const title = env.title || '';
	const options = env.options || '';
	const user = `题目类型：${type}\n题目：${title}${options ? '\n选项：\n' + options : ''}`;
	return [
		{ role: 'system', content: config.systemPrompt || DEFAULT_AI_SYSTEM_PROMPT },
		{ role: 'user', content: user }
	];
}

/**
 * 生成 data.messages 字段解析器（在题库配置中被 `Function()` 构造执行，必须自包含、不能引用外部变量）。
 */
function createMessagesHandler(systemPrompt: string): string {
	const prompt = JSON.stringify(systemPrompt);
	return `return (env) => {
	var type = (env && env.type) || 'unknown';
	var title = (env && env.title) || '';
	var options = (env && env.options) || '';
	var user = '题目类型：' + type + '\\n题目：' + title + (options ? '\\n选项：\\n' + options : '');
	return [
		{ role: 'system', content: ${prompt} },
		{ role: 'user', content: user }
	];
}`;
}

/**
 * 生成响应解析器（自包含）。
 *
 * 兼容：
 * - OpenAI Chat Completions：`choices[0].message.content`（字符串或分段数组）；
 * - Responses API 风格：`output_text`；
 * - 纯文本或 `{ answer: ... }` 等简化格式。
 *
 * 失败时抛错，由 `defaultAnswerWrapperHandler` 捕获后作为该题库的 error 展示，
 * 不影响其他题库与原有答题流程。
 */
function createResponseHandler(): string {
	return `return (res) => {
	var fail = function (msg) { throw new Error('AI 搜题失败：' + msg); };
	var data = res;
	if (typeof data === 'string') {
		try { data = JSON.parse(data); }
		catch (e) { fail('接口返回格式异常（内容不是 JSON，请确认接口地址为 OpenAI 兼容格式）'); }
	}
	if (!data || typeof data !== 'object') { fail('接口返回格式异常'); }
	if (data.error) {
		var err = data.error;
		var raw = (err && (err.message || err.msg || err.code || err.type)) || (typeof err === 'string' ? err : '');
		var text = String(raw || '未知错误');
		if (/401|403|unauthor|invalid.{0,24}(api|key|token)|api.?key|authentication|permission/i.test(text)) {
			fail('API 密钥无效或无权限，请检查 API Key 与模型权限（' + text + '）');
		}
		if (/429|rate.?limit|quota|insufficient|余额|额度/i.test(text)) {
			fail('请求频率或额度受限，请稍后重试或检查账户余额（' + text + '）');
		}
		fail(text);
	}
	var content = '';
	var choice = data.choices && data.choices[0];
	if (choice) {
		var message = choice.message || choice.delta || {};
		content = message.content;
		if (content === undefined || content === null) { content = choice.text; }
		if ((content === undefined || content === null) && typeof message.refusal === 'string') {
			content = message.refusal;
		}
	}
	if (content === undefined || content === null || content === '') {
		content = data.output_text || data.answer || data.content || data.response;
	}
	if (Array.isArray(content)) {
		content = content
			.map(function (part) { return (part && (part.text || part.content)) || ''; })
			.join('');
	}
	if (typeof content !== 'string' || !content.trim()) { fail('接口返回格式异常（未找到回答内容，请确认接口为 OpenAI 兼容格式）'); }
	var normalized = content.trim()
		.replace(/^答案\\s*[:：]\\s*/i, '')
		.replace(/^AI\\s*[:：]?\\s*/i, '')
		.replace(/[。.!！?？"'“”‘’\\s]/g, '');
	var uncertain = /^(无法确定|不确定|无法回答|无法判断|不能确定|不知道|未知|无答案|无法作答)$/i.test(normalized);
	return [undefined, content.trim(), { ai: true, uncertain: uncertain }];
}`;
}

/**
 * 根据配置创建 AI 搜题的 {@link AnswererWrapper}。
 * 配置不完整时返回 undefined（不注入，原有题库与答题流程保持不变）。
 */
export function createAIAnswererWrapper(config: AISearchConfig): AnswererWrapper | undefined {
	const validation = validateAISearchConfig(config);
	if (!validation.ok) return undefined;

	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

	return {
		name: AI_SEARCH_ANSWERER_NAME,
		url: config.apiUrl,
		homepage: 'https://docs.ocsjs.com/docs/other/api',
		method: 'post',
		// 使用 text 而非 json：由 handler 自行 JSON.parse，从而把「非 JSON 返回」转换为友好提示
		responseType: 'text',
		type: config.requestType,
		headers,
		timeout_seconds: config.timeoutSeconds,
		data: {
			model: config.model,
			temperature: config.temperature,
			max_tokens: config.maxTokens,
			stream: false,
			messages: { handler: createMessagesHandler(config.systemPrompt) }
		},
		handler: createResponseHandler()
	};
}

/**
 * 把 AI 搜题追加到题库列表末尾（仅当启用且配置有效）。
 * - 返回新数组，不修改传入的题库列表；
 * - 未启用/配置无效时原样返回，保证原有题库配置零影响。
 */
export function mergeAIAnswererIntoWrappers(
	wrappers: AnswererWrapper[],
	cfg: Record<string, any> | undefined
): AnswererWrapper[] {
	const list = Array.isArray(wrappers) ? wrappers : [];
	const config = readAISearchConfig(cfg);
	if (!config.enable) return list;
	const wrapper = createAIAnswererWrapper(config);
	if (!wrapper) return list;
	return [...list, wrapper];
}
