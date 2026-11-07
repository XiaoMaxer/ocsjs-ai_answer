import debounce from 'lodash/debounce';

/**
 * Web Worker 源码（内联为字符串，通过 Blob URL 加载）。
 * 后台标签页中主线程 setTimeout 会被浏览器节流（5 分钟后间隔至少 1 分钟），
 * 而 Worker 内部的定时器不受此限制，可保证最小化/切屏时延迟仍按设定值执行。
 */
const SLEEP_WORKER_SOURCE = `
self.onmessage = function (e) {
	var data = e.data || {};
	var id = data.id;
	var delay = Number(data.delay) || 0;
	setTimeout(function () {
		self.postMessage({ id: id });
	}, delay);
};
`;

/** 单例 sleep worker 及其待解析回调表；Worker 创建失败时为 undefined，此时退化为主线程 setTimeout */
let sleepWorker: Worker | undefined;
const sleepResolvers = new Map<number, () => void>();
let sleepWorkerInitTried = false;
let sleepSeq = 0;

/**
 * 懒加载 sleep worker。仅在浏览器环境尝试创建；创建失败（如 CSP 禁止 Blob Worker）则保持 undefined。
 */
function getSleepWorker(): Worker | undefined {
	if (sleepWorkerInitTried) return sleepWorker;
	sleepWorkerInitTried = true;
	if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
		return undefined;
	}
	try {
		const blob = new Blob([SLEEP_WORKER_SOURCE], { type: 'application/javascript' });
		const url = URL.createObjectURL(blob);
		const worker = new Worker(url);
		worker.onmessage = (e: MessageEvent) => {
			const id = e.data?.id as number | undefined;
			if (id !== undefined) {
				const resolve = sleepResolvers.get(id);
				if (resolve) {
					sleepResolvers.delete(id);
					resolve();
				}
			}
		};
		worker.onerror = () => {
			// Worker 出错时不再使用，后续 sleep 退化为 setTimeout
			sleepWorker = undefined;
		};
		sleepWorker = worker;
		return worker;
	} catch {
		sleepWorker = undefined;
		return undefined;
	}
}

/**
 * 公共的工具库
 */
export const $ = {
	/** 创建唯一id ， 不带横杠 */
	uuid() {
		return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
			const r = (Math.random() * 16) | 0;
			const v = c === 'x' ? r : (r & 0x3) | 0x8;
			return v.toString(16);
		});
	},

	/**
	 * 生成随机数， 使用 Math.round 取整
	 * @param min 最小值
	 * @param max 最大值
	 */
	random(min: number, max: number) {
		return Math.round(Math.random() * (max - min)) + min;
	},

	/**
	 * 暂停
	 *
	 * 优先使用 Web Worker 定时器：后台标签页中主线程 setTimeout 会被浏览器节流，
	 * 而 Worker 内部定时器不受影响，可保证最小化/切屏时延迟仍按设定值执行。
	 * 非浏览器环境或 Worker 不可用时退化为普通 setTimeout。
	 *
	 * @param period 毫秒
	 */
	async sleep(period: number): Promise<void> {
		const worker = getSleepWorker();
		if (!worker) {
			return new Promise((resolve) => {
				setTimeout(resolve, period);
			});
		}
		return new Promise<void>((resolve) => {
			const id = ++sleepSeq;
			sleepResolvers.set(id, resolve);
			worker.postMessage({ id, delay: period });
		});
	},

	/**
	 * 当前是否处于浏览器环境
	 */
	isInBrowser(): boolean {
		return typeof window !== 'undefined' && typeof window.document !== 'undefined';
	},

	/**
	 * 使元素变成纯文本对象，（跨域时对象上下文会被销毁）
	 * @param el 元素
	 */
	elementToRawObject(el: HTMLElement | undefined | null) {
		return {
			innerText: el?.innerText,
			innerHTML: el?.innerHTML,
			textContent: el?.textContent
		} as any;
	},

	/**
	 * 监听页面宽度变化
	 * @param el 任意元素，如果此元素被移除，则不执行 resize 回调
	 * @param handler resize 回调
	 */
	onresize<E extends HTMLElement>(el: E, handler: (el: E) => void) {
		const resize = debounce(() => {
			/**
			 * 如果元素被删除，则移除监听器
			 * 不使用 el.parentElement 是因为如果是顶级元素，例如 shadowRoot 中的一级子元素， el.parentNode 不为空，但是 el.parentElement 为空
			 */
			if (el.parentNode === null) {
				window.removeEventListener('resize', resize);
			} else {
				handler(el);
			}
		}, 200);
		resize();
		window.addEventListener('resize', resize);
	},
	/** 是否处于顶级 window ，而不是子 iframe */
	isInTopWindow() {
		return self === top;
	},
	/**
	 * 创建弹出窗口
	 * @param url 地址
	 * @param winName 窗口名
	 * @param w 宽
	 * @param h 高
	 * @param scroll 滚动条
	 */
	createCenteredPopupWindow(
		url: string,
		winName: string,
		opts: {
			width: number;
			height: number;
			scrollbars: boolean;
			resizable: boolean;
		}
	) {
		const { width, height, scrollbars, resizable } = opts;
		const LeftPosition = screen.width ? (screen.width - width) / 2 : 0;
		const TopPosition = screen.height ? (screen.height - height) / 2 : 0;

		const settings =
			'height=' +
			height +
			',width=' +
			width +
			',top=' +
			TopPosition +
			',left=' +
			LeftPosition +
			',scrollbars=' +
			(scrollbars ? 'yes' : 'no') +
			',resizable=' +
			(resizable ? 'yes' : 'no');

		return window.open(url, winName, settings);
	},
	transition: async (
		el: HTMLElement,
		properties: keyof CSSStyleDeclaration,
		duration_ms: number,
		val: any,
		options?: {
			reset_ms?: number;
			timing_function?: string;
		}
	) => {
		return new Promise<void>((resolve) => {
			const original_val = Reflect.get(el.style, properties) || '';
			el.style.transition = `${String(properties)} ${duration_ms}s ${options?.timing_function || 'ease-in-out'}`;
			Reflect.set(el.style, properties, val);
			el.addEventListener('transitionend', function handler() {
				el.removeEventListener('transitionend', handler);
				setTimeout(() => {
					Reflect.set(el.style, properties, original_val);
					setTimeout(() => {
						el.style.transition = '';
					}, duration_ms * 1000);
				}, (options?.reset_ms || 0) * 1000);
				resolve();
			});
		});
	}
};
