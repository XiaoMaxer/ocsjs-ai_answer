import assert from 'node:assert/strict';
import {
	AI_SEARCH_ANSWERER_NAME,
	AI_SEARCH_DEFAULTS,
	DEFAULT_AI_SYSTEM_PROMPT,
	normalizeAISearchConfig,
	normalizeAISearchApiUrl,
	validateAISearchConfig,
	buildAIMessages,
	createAIAnswererWrapper,
	mergeAIAnswererIntoWrappers,
	readAISearchConfig
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

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length) {
	failures.forEach((failure) => console.error('  - ' + failure));
	process.exit(1);
}
