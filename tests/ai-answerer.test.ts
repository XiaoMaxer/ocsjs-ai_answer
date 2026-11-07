import assert from 'node:assert/strict';
import {
	AI_SEARCH_ANSWERER_NAME,
	AI_RANDOM_FALLBACK_NAME,
	AI_SEARCH_DEFAULTS,
	DEFAULT_AI_SYSTEM_PROMPT,
	normalizeAISearchConfig,
	normalizeAISearchApiUrl,
	validateAISearchConfig,
	buildAIMessages,
	createAIAnswererWrapper,
	mergeAIAnswererIntoWrappers,
	readAISearchConfig,
	isAIUncertainAnswer,
	createRandomFallbackAnswer,
	applyAIUncertainFallback,
	shouldDeferRandomFallbackToPlatform
} from '../packages/scripts/src/utils/ai-answerer';

/** 测试专用占位值：刻意不使用真实密钥格式，避免被误认为泄露或触发密钥扫描 */
const TEST_API_KEY = 'unit-test-key';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
	try {
		fn();
		passed++;
		console.log('  ✓ ' + name);
	} catch (error: any) {
		failures.push(name + ' -> ' + error.message);
		console.error('  ✗ ' + name + '\n    ' + error.message);
	}
}

/** 执行由脚本动态生成的 handler（与线上运行方式一致：Function 构造 + 调用） */
function runHandler(wrapper: ReturnType<typeof createAIAnswererWrapper>, res: unknown) {
	assert.ok(wrapper, 'wrapper 不应为空');
	assert.equal(typeof wrapper!.handler, 'string', 'handler 应为字符串');
	const handler = Function(wrapper!.handler as string)();
	return handler(res);
}

function createWrapper() {
	return createAIAnswererWrapper(
		normalizeAISearchConfig({
			enable: true,
			apiUrl: 'https://api.deepseek.com/v1',
			apiKey: TEST_API_KEY,
			model: 'deepseek-chat'
		})
	);
}

console.log('\n[1] 配置归一化与校验');

test('空配置使用默认值', () => {
	const config = normalizeAISearchConfig({});
	assert.equal(config.enable, false);
	assert.equal(config.apiUrl, '');
	assert.equal(config.model, '');
	assert.equal(config.temperature, AI_SEARCH_DEFAULTS.temperature);
	assert.equal(config.maxTokens, AI_SEARCH_DEFAULTS.maxTokens);
	assert.equal(config.timeoutSeconds, AI_SEARCH_DEFAULTS.timeoutSeconds);
	assert.equal(config.requestType, AI_SEARCH_DEFAULTS.requestType);
	assert.equal(config.systemPrompt, DEFAULT_AI_SYSTEM_PROMPT);
});

test('数值参数被裁剪到合法范围', () => {
	assert.equal(normalizeAISearchConfig({ temperature: 5 }).temperature, 2);
	assert.equal(normalizeAISearchConfig({ temperature: -1 }).temperature, 0);
	assert.equal(normalizeAISearchConfig({ temperature: 'abc' }).temperature, AI_SEARCH_DEFAULTS.temperature);
	assert.equal(normalizeAISearchConfig({ maxTokens: 0 }).maxTokens, 1);
	assert.equal(normalizeAISearchConfig({ maxTokens: 99999 }).maxTokens, 32768);
	assert.equal(normalizeAISearchConfig({ timeoutSeconds: 1 }).timeoutSeconds, 5);
	assert.equal(normalizeAISearchConfig({ timeoutSeconds: 9999 }).timeoutSeconds, 600);
});

test('字符串配置去除反引号与首尾空白', () => {
	const config = normalizeAISearchConfig({
		apiUrl: '`https://api.deepseek.com/v1`',
		apiKey: '  unit-test-key  ',
		model: ' deepseek-chat '
	});
	assert.equal(config.apiUrl, 'https://api.deepseek.com/v1/chat/completions');
	assert.equal(config.apiKey, 'unit-test-key');
	assert.equal(config.model, 'deepseek-chat');
});

test('系统提示词为空时回退默认值', () => {
	assert.equal(normalizeAISearchConfig({ systemPrompt: '   ' }).systemPrompt, DEFAULT_AI_SYSTEM_PROMPT);
});

test('接口地址自动补全', () => {
	assert.equal(normalizeAISearchApiUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
	assert.equal(normalizeAISearchApiUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
	assert.equal(
		normalizeAISearchApiUrl('https://api.openai.com/v1/chat/completions'),
		'https://api.openai.com/v1/chat/completions'
	);
	// 自定义路径（反向代理 / Azure）保持原样
	assert.equal(
		normalizeAISearchApiUrl('https://example.com/openai/deployments/x/chat/completions?api-version=1'),
		'https://example.com/openai/deployments/x/chat/completions?api-version=1'
	);
	assert.equal(normalizeAISearchApiUrl(''), '');
});

test('地址或模型缺失时校验失败，密钥允许为空（本地模型）', () => {
	const config = normalizeAISearchConfig({ apiUrl: '', model: '' });
	const result = validateAISearchConfig(config);
	assert.equal(result.ok, false);
	assert.equal(result.errors.length, 2);
	assert.match(result.errors.join('|'), /接口地址/);
	assert.match(result.errors.join('|'), /模型名称/);

	const local = normalizeAISearchConfig({ apiUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' });
	assert.equal(validateAISearchConfig(local).ok, true);
});

test('非法协议与非法地址被识别', () => {
	assert.match(
		validateAISearchConfig(normalizeAISearchConfig({ apiUrl: 'ftp://x', model: 'm' })).errors.join('|'),
		/http/
	);
	assert.match(
		validateAISearchConfig(normalizeAISearchConfig({ apiUrl: 'not-a-url', model: 'm' })).errors.join('|'),
		/格式/
	);
});

test('从全局设置 cfg 正确读取 AI 配置', () => {
	const config = readAISearchConfig({
		aiSearchEnable: true,
		aiSearchApiUrl: 'https://api.deepseek.com/v1',
		aiSearchApiKey: TEST_API_KEY,
		aiSearchModel: 'deepseek-chat',
		aiSearchTemperature: '0.2',
		aiSearchMaxTokens: 512,
		aiSearchTimeout: 30,
		aiSearchRequestType: 'fetch'
	});
	assert.equal(config.enable, true);
	assert.equal(config.apiUrl, 'https://api.deepseek.com/v1/chat/completions');
	assert.equal(config.temperature, 0.2);
	assert.equal(config.maxTokens, 512);
	assert.equal(config.timeoutSeconds, 30);
	assert.equal(config.requestType, 'fetch');
});

console.log('\n[2] 题库包装器生成');

test('生成的包装器字段完整且符合 OpenAI 兼容协议', () => {
	const wrapper = createWrapper();
	assert.ok(wrapper);
	assert.equal(wrapper!.name, AI_SEARCH_ANSWERER_NAME);
	assert.equal(wrapper!.url, 'https://api.deepseek.com/v1/chat/completions');
	assert.equal(wrapper!.method, 'post');
	assert.equal(wrapper!.type, 'GM_xmlhttpRequest');
	assert.equal(wrapper!.responseType, 'text');
	assert.equal(wrapper!.timeout_seconds, AI_SEARCH_DEFAULTS.timeoutSeconds);
	assert.equal(wrapper!.headers['Content-Type'], 'application/json');
	assert.equal(wrapper!.headers['Authorization'], `Bearer ${TEST_API_KEY}`);
	assert.equal(wrapper!.data.model, 'deepseek-chat');
	assert.equal(wrapper!.data.stream, false);
	assert.equal(typeof wrapper!.data.messages, 'object');
	assert.equal(typeof wrapper!.data.messages.handler, 'string');
});

test('未填写密钥时不发送 Authorization 头', () => {
	const wrapper = createAIAnswererWrapper(
		normalizeAISearchConfig({ apiUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' })
	);
	assert.ok(wrapper);
	assert.equal('Authorization' in wrapper!.headers, false);
});

test('配置无效时不生成包装器（不影响原有流程）', () => {
	assert.equal(createAIAnswererWrapper(normalizeAISearchConfig({ apiUrl: '', model: '' })), undefined);
	assert.equal(createAIAnswererWrapper(normalizeAISearchConfig({ apiUrl: 'https://x.com/v1', model: '' })), undefined);
});

test('消息构造包含题目类型、题干与选项', () => {
	const config = normalizeAISearchConfig({ apiUrl: 'https://x.com/v1', model: 'm' });
	const messages = buildAIMessages(config, { type: 'single', title: '以下哪个是质数？', options: 'A. 4\nB. 7' });
	assert.equal(messages.length, 2);
	assert.equal(messages[0].role, 'system');
	assert.equal(messages[0].content, DEFAULT_AI_SYSTEM_PROMPT);
	assert.equal(messages[1].role, 'user');
	assert.match(messages[1].content, /题目类型：single/);
	assert.match(messages[1].content, /以下哪个是质数？/);
	assert.match(messages[1].content, /选项：/);
});

test('data.messages handler 与 buildAIMessages 输出一致', () => {
	const wrapper = createWrapper();
	const handler = Function((wrapper!.data.messages as any).handler)();
	const env = { type: 'multiple', title: '多选题', options: 'A. 1\nB. 2' };
	assert.deepEqual(
		handler(env),
		buildAIMessages(normalizeAISearchConfig({ apiUrl: 'https://x.com/v1', model: 'm' }), env)
	);
});

console.log('\n[3] AI 返回解析（含异常与降级提示）');

test('解析 OpenAI 兼容返回并标记 ai', () => {
	const result = runHandler(createWrapper(), JSON.stringify({ choices: [{ message: { content: 'A#C' } }] }));
	assert.equal(result[0], undefined);
	assert.equal(result[1], 'A#C');
	assert.equal(result[2].ai, true);
});

test('直接传入对象同样可解析', () => {
	const result = runHandler(createWrapper(), { choices: [{ message: { content: ' 正确 ' } }] });
	assert.equal(result[1], '正确');
});

test('兼容内容分段数组与 output_text', () => {
	let result = runHandler(
		createWrapper(),
		JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'B' }] } }] })
	);
	assert.equal(result[1], 'B');

	result = runHandler(createWrapper(), { output_text: 'C' });
	assert.equal(result[1], 'C');
});

test('401 / 403 密钥或权限错误给出友好提示', () => {
	assert.throws(
		() =>
			runHandler(
				createWrapper(),
				JSON.stringify({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } })
			),
		/AI 搜题失败：API 密钥无效或无权限/
	);
	assert.throws(
		() => runHandler(createWrapper(), JSON.stringify({ error: { message: '403 Forbidden', code: 'permission' } })),
		/AI 搜题失败：API 密钥无效或无权限/
	);
});

test('429 频率或额度受限给出友好提示', () => {
	assert.throws(
		() =>
			runHandler(createWrapper(), JSON.stringify({ error: { message: 'Rate limit exceeded', code: 'rate_limit' } })),
		/AI 搜题失败：请求频率或额度受限/
	);
});

test('非 JSON 返回与缺失回答内容给出格式异常提示', () => {
	assert.throws(() => runHandler(createWrapper(), '<html>502 Bad Gateway</html>'), /AI 搜题失败：接口返回格式异常/);
	assert.throws(() => runHandler(createWrapper(), JSON.stringify({ choices: [] })), /AI 搜题失败：接口返回格式异常/);
	assert.throws(
		() => runHandler(createWrapper(), JSON.stringify({ choices: [{ message: { content: '   ' } }] })),
		/AI 搜题失败：接口返回格式异常/
	);
});

test('未知接口错误会透传原始信息', () => {
	assert.throws(
		() => runHandler(createWrapper(), JSON.stringify({ error: { message: 'service unavailable' } })),
		/service unavailable/
	);
});

console.log('\n[4] 与原有题库的兼容性');

const legacyWrapper = {
	name: '言溪题库',
	url: 'https://tk.enncy.cn/query',
	method: 'post',
	type: 'GM_xmlhttpRequest',
	contentType: 'json',
	headers: { 'Content-Type': 'application/json' },
	data: { token: 'test', title: '${title}', options: '${options}', type: '${type}' },
	handler: 'return (res)=>[res.data.question, res.data.answer]'
} as any;

test('未启用 AI 时题库列表原样保留', () => {
	const merged = mergeAIAnswererIntoWrappers([legacyWrapper], { aiSearchEnable: false });
	assert.equal(merged.length, 1);
	assert.deepEqual(merged[0], legacyWrapper);
	assert.equal(merged[0].name, '言溪题库');
	assert.equal(merged[0].handler, legacyWrapper.handler);
});

test('启用 AI 时追加到末尾且不修改原题库对象', () => {
	const originals = [legacyWrapper];
	const merged = mergeAIAnswererIntoWrappers(originals, {
		aiSearchEnable: true,
		aiSearchApiUrl: 'https://api.deepseek.com/v1',
		aiSearchApiKey: TEST_API_KEY,
		aiSearchModel: 'deepseek-chat'
	});
	assert.equal(merged.length, 2);
	assert.equal(merged[0].name, '言溪题库');
	assert.deepEqual(merged[0], legacyWrapper);
	assert.equal(merged[1].name, AI_SEARCH_ANSWERER_NAME);
	// 原数组未被修改
	assert.equal(originals.length, 1);
});

test('启用但配置无效时不影响原有题库（静默降级）', () => {
	const merged = mergeAIAnswererIntoWrappers([legacyWrapper], {
		aiSearchEnable: true,
		aiSearchApiUrl: '',
		aiSearchModel: ''
	});
	assert.equal(merged.length, 1);
	assert.deepEqual(merged[0], legacyWrapper);
});

test('空题库 + 启用 AI 时可正常生成列表（AI-only 模式）', () => {
	const merged = mergeAIAnswererIntoWrappers([], {
		aiSearchEnable: true,
		aiSearchApiUrl: 'https://api.deepseek.com/v1',
		aiSearchModel: 'deepseek-chat'
	});
	assert.equal(merged.length, 1);
	assert.equal(merged[0].name, AI_SEARCH_ANSWERER_NAME);
});

test('原有题库包装器不携带 timeout_seconds 时仍保持原样（旧配置兼容）', () => {
	assert.equal('timeout_seconds' in legacyWrapper, false);
	assert.deepEqual(mergeAIAnswererIntoWrappers([legacyWrapper], {}), [legacyWrapper]);
});

console.log(`\n[5] AI 无法确定时的兜底逻辑`);

test('识别「无法确定」类回答', () => {
	assert.equal(isAIUncertainAnswer('AI无法确定'), true);
	assert.equal(isAIUncertainAnswer('答案：无法确定。'), true);
	assert.equal(isAIUncertainAnswer('无法判断'), true);
	assert.equal(isAIUncertainAnswer('不知道'), true);
	assert.equal(isAIUncertainAnswer('A'), false);
	assert.equal(isAIUncertainAnswer('正确'), false);
	assert.equal(isAIUncertainAnswer('无法确定协议细节'), false);
});

test('响应处理器标记不确定答案，但不影响正常答案', () => {
	let result = runHandler(createWrapper(), JSON.stringify({ choices: [{ message: { content: 'AI无法确定' } }] }));
	assert.equal(result[2].ai, true);
	assert.equal(result[2].uncertain, true);

	result = runHandler(createWrapper(), JSON.stringify({ choices: [{ message: { content: 'A#C' } }] }));
	assert.equal(result[2].uncertain, false);
});

test('随机兜底答案生成（单选 / 多选 / 判断 / 填空）', () => {
	assert.equal(createRandomFallbackAnswer({ type: 'single', optionCount: 4, random: () => 0 }), 'A');
	assert.equal(createRandomFallbackAnswer({ type: 'single', optionCount: 4, random: () => 0.99 }), 'D');
	assert.equal(createRandomFallbackAnswer({ type: 'single', optionCount: 0, random: () => 0 }), undefined);

	assert.match(createRandomFallbackAnswer({ type: 'multiple', optionCount: 4, random: () => 0 })!, /^[A-D]$/);
	assert.equal(createRandomFallbackAnswer({ type: 'multiple', optionCount: 4, random: () => 0.99 }), 'A#B#C#D');
	assert.equal(createRandomFallbackAnswer({ type: 'multiple', optionCount: 0 }), undefined);

	assert.equal(createRandomFallbackAnswer({ type: 'judgement', optionCount: 2, random: () => 0 }), '正确');
	assert.equal(createRandomFallbackAnswer({ type: 'judgement', optionCount: 2, random: () => 0.99 }), '错误');

	assert.equal(
		createRandomFallbackAnswer({
			type: 'completion',
			optionCount: 2,
			completionTexts: ['不会', '不知道'],
			random: () => 0
		}),
		'不会#不会'
	);
	assert.equal(
		createRandomFallbackAnswer({ type: 'completion', optionCount: 1, completionTexts: [], random: () => 0 }),
		'不会'
	);
});

test('题库有答案时剔除 AI 不确定回答并优先使用题库', () => {
	const infos: any[] = [
		{ name: '言溪题库', results: [{ question: '题目', answer: 'B' }] },
		{
			name: AI_SEARCH_ANSWERER_NAME,
			results: [{ question: undefined, answer: 'AI无法确定', extra_data: { ai: true, uncertain: true } }]
		}
	];
	const result = applyAIUncertainFallback(infos, { type: 'single', optionCount: 4, enabled: true });
	assert.equal(result.usedBank, true);
	assert.equal(result.usedRandom, false);
	assert.equal(infos.length, 2, '不新增随机兜底条目');
	assert.equal(infos[0].results[0].answer, 'B');
	assert.equal(infos[1].results.length, 0, '不确定答案被剔除，禁止参与匹配与提交');
	assert.match(infos[1].error, /已改用题库答案/);
});

test('题库无答案时启用随机兜底（默认策略）', () => {
	const infos: any[] = [
		{ name: '言溪题库', results: [], error: '未搜到' },
		{
			name: AI_SEARCH_ANSWERER_NAME,
			results: [{ question: undefined, answer: '无法确定', extra_data: { ai: true, uncertain: true } }]
		}
	];
	const result = applyAIUncertainFallback(infos, {
		type: 'single',
		title: '题目',
		optionCount: 4,
		enabled: true,
		random: () => 0.99
	});
	assert.equal(result.usedRandom, true);
	assert.equal(result.randomAnswer, 'D');
	assert.equal(infos.length, 3);
	assert.equal(infos[2].name, AI_RANDOM_FALLBACK_NAME);
	assert.equal(infos[2].results[0].answer, 'D');
	assert.match(infos[1].error, /随机答案兜底/);
});

test('关闭随机兜底时不生成随机答案', () => {
	const infos: any[] = [
		{
			name: AI_SEARCH_ANSWERER_NAME,
			results: [{ question: undefined, answer: '无法确定', extra_data: { uncertain: true } }]
		}
	];
	const result = applyAIUncertainFallback(infos, { type: 'single', optionCount: 4, enabled: false });
	assert.equal(result.usedRandom, false);
	assert.equal(infos.length, 1);
	assert.equal(infos[0].results.length, 0);
	assert.match(infos[0].error, /留空不答/);
});

test('正常 AI 答案与原有题库结果完全不受兜底逻辑影响', () => {
	const infos: any[] = [
		{ name: '言溪题库', results: [{ question: '题目', answer: 'A' }] },
		{
			name: AI_SEARCH_ANSWERER_NAME,
			results: [{ question: undefined, answer: 'A', extra_data: { ai: true, uncertain: false } }]
		}
	];
	const snapshot = JSON.stringify(infos);
	const result = applyAIUncertainFallback(infos, { type: 'single', optionCount: 4, enabled: true });
	assert.equal(result.usedBank, false);
	assert.equal(result.usedRandom, false);
	assert.equal(JSON.stringify(infos), snapshot);
});

console.log(`\n[6] 与超星随机功能的优先级（方案 A）`);

test('未开启超星随机时不让位', () => {
	const cfg = {};
	['single', 'multiple', 'judgement', 'completion'].forEach((type) => {
		assert.equal(shouldDeferRandomFallbackToPlatform(type, cfg), false, type + ' 不应让位');
	});
	assert.equal(shouldDeferRandomFallbackToPlatform(undefined, cfg), false, '缺少题型时不让位');
});

test('开启「随机选择」时选择题让位，填空题不让位', () => {
	const cfg = { 'randomWork-choice': true };
	assert.equal(shouldDeferRandomFallbackToPlatform('single', cfg), true);
	assert.equal(shouldDeferRandomFallbackToPlatform('multiple', cfg), true);
	assert.equal(shouldDeferRandomFallbackToPlatform('judgement', cfg), true);
	assert.equal(shouldDeferRandomFallbackToPlatform('completion', cfg), false);
});

test('开启「随机填空」时填空题让位，选择题不让位', () => {
	const cfg = { 'randomWork-complete': true };
	assert.equal(shouldDeferRandomFallbackToPlatform('completion', cfg), true);
	assert.equal(shouldDeferRandomFallbackToPlatform('single', cfg), false);
	assert.equal(shouldDeferRandomFallbackToPlatform('multiple', cfg), false);
	assert.equal(shouldDeferRandomFallbackToPlatform('judgement', cfg), false);
});

test('两个随机开关同时开启时全部题型让位', () => {
	const cfg = { 'randomWork-choice': true, 'randomWork-complete': true };
	['single', 'multiple', 'judgement', 'completion'].forEach((type) => {
		assert.equal(shouldDeferRandomFallbackToPlatform(type, cfg), true, type + ' 应让位');
	});
});

test('让位时不生成随机答案，并提示交由平台随机作答', () => {
	const infos: any[] = [
		{
			name: AI_SEARCH_ANSWERER_NAME,
			results: [{ question: undefined, answer: '无法确定', extra_data: { ai: true, uncertain: true } }]
		}
	];
	const result = applyAIUncertainFallback(infos, {
		type: 'single',
		title: '题目',
		optionCount: 4,
		enabled: false,
		deferred: true
	});
	assert.equal(result.usedBank, false);
	assert.equal(result.usedRandom, false);
	assert.equal(result.uncertain, true);
	assert.equal(infos.length, 1, '不新增随机兜底条目');
	assert.equal(infos[0].results.length, 0, '不确定答案被剔除');
	assert.match(infos[0].error, /交由平台随机作答/);
	assert.equal(infos[0].error.includes('随机答案兜底'), false, '不应提示 AI 随机兜底');
});

test('让位时题库有答案仍优先使用题库（最高优先级）', () => {
	const infos: any[] = [
		{ name: '言溪题库', results: [{ question: '题目', answer: 'B' }] },
		{
			name: AI_SEARCH_ANSWERER_NAME,
			results: [{ question: undefined, answer: 'AI无法确定', extra_data: { ai: true, uncertain: true } }]
		}
	];
	const result = applyAIUncertainFallback(infos, {
		type: 'single',
		optionCount: 4,
		enabled: false,
		deferred: true
	});
	assert.equal(result.usedBank, true);
	assert.equal(result.usedRandom, false);
	assert.equal(infos[1].results.length, 0);
	assert.match(infos[1].error, /已改用题库答案/);
	assert.equal(infos.length, 2);
});

test('未让位且兜底开启时仍保留 AI 随机兜底（原行为不变）', () => {
	const infos: any[] = [
		{
			name: AI_SEARCH_ANSWERER_NAME,
			results: [{ question: undefined, answer: '无法确定', extra_data: { ai: true, uncertain: true } }]
		}
	];
	const result = applyAIUncertainFallback(infos, {
		type: 'single',
		title: '题目',
		optionCount: 4,
		enabled: true,
		deferred: false,
		random: () => 0
	});
	assert.equal(result.usedRandom, true);
	assert.equal(result.randomAnswer, 'A');
	assert.equal(infos.length, 2);
	assert.match(infos[0].error, /随机答案兜底/);
	assert.equal(infos[1].name, AI_RANDOM_FALLBACK_NAME);
});

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
	failures.forEach((failure) => console.error('  - ' + failure));
	process.exit(1);
}
