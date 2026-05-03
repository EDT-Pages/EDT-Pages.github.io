// === Leaflet Lazy Loader ===
let _leafletLoaded = false;
let _leafletLoading = null;
function loadLeaflet() {
    if (typeof L !== 'undefined') { _leafletLoaded = true; return Promise.resolve(); }
    if (_leafletLoading) return _leafletLoading;
    _leafletLoading = new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(link);
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
        script.onload = () => { _leafletLoaded = true; resolve(); };
        script.onerror = () => reject(new Error('Failed to load Leaflet'));
        document.head.appendChild(script);
    });
    return _leafletLoading;
}

// === Global Error Boundary ===
window.onerror = function(msg, url, line, col, error) {
    console.error('[Global Error]', msg, url, line, col, error);
    try {
        if (typeof showToast === 'function') showToast('⚠️ 发生错误: ' + (msg || '未知错误'), 'error');
    } catch(e) {}
    return false;
};
window.addEventListener('unhandledrejection', function(event) {
    console.error('[Unhandled Promise]', event.reason);
});

let currentConfig = {};
let originalConfig = {};
let modifiedSections = new Set();
let subConfigData = null;
let hasMultipleHosts = false; // 标记是否存在多个 HOSTS
let isLowPerformanceMode = false;
let pendingSSTLSPreviousValue = null;
const LOW_PERF_STORAGE_KEY = 'adminLowPerformanceMode';
let performanceRecheckScheduled = false;
const WORKER_VERSION_SOURCE_URL = 'https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js';
const PAGES_ZIP_DOWNLOAD_URL = 'https://github.com/cmliu/edgetunnel/archive/refs/heads/main.zip';
const CHANGELOG_RAW_URL = 'https://raw.githubusercontent.com/cmliu/edgetunnel/refs/heads/main/CHANGELOG';
const HTTPS_PROXY_MIN_VERSION = 20260413174651;
let cachedWorkerVersionRawText = '';
let cachedLatestOnlineVersion = 0;
let cachedCurrentVersionNumber = 0;
let cachedCurrentVersionFullText = '';
let cachedChangelogRawText = '';
let cachedChangelogLoadedAt = 0;
let pendingChangelogLoadPromise = null;
let httpsProxyFeatureEnabled = false;

function parseForcedLowPerformanceMode() {
    try {
        const params = new URLSearchParams(window.location.search);
        const lite = params.get('lite');
        if (lite === '1' || lite === 'true') {
            localStorage.setItem(LOW_PERF_STORAGE_KEY, '1');
            return true;
        }
        if (lite === '0' || lite === 'false') {
            localStorage.setItem(LOW_PERF_STORAGE_KEY, '0');
            return false;
        }
    } catch (_) {
        // ignore URL parse errors
    }

    const saved = localStorage.getItem(LOW_PERF_STORAGE_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
    return null;
}

function enableLowPerformanceMode(reason) {
    if (isLowPerformanceMode) return;
    isLowPerformanceMode = true;
    document.documentElement.classList.add('low-performance-mode');
    console.info(`[perf] Low performance mode enabled: ${reason}`);
}

function initBackgroundIframe() {
    const iframe = document.getElementById('background-iframe');
    if (!iframe) return;

    if (isLowPerformanceMode) {
        iframe.setAttribute('src', 'about:blank');
        return;
    }

    const targetSrc = iframe.getAttribute('data-src') || '/';
    if (iframe.getAttribute('src') !== targetSrc) {
        iframe.setAttribute('src', targetSrc);
    }
}

function measureAverageFrameTime(sampleCount = 18, timeoutMs = 1500) {
    return new Promise((resolve) => {
        if (!window.requestAnimationFrame) {
            resolve(16.7);
            return;
        }

        let lastTime = 0;
        let frameCount = 0;
        let totalDelta = 0;
        let rafId = 0;
        let finished = false;

        const finish = (value) => {
            if (finished) return;
            finished = true;
            if (rafId) cancelAnimationFrame(rafId);
            clearTimeout(timeoutId);
            resolve(value);
        };

        const step = (now) => {
            if (lastTime > 0) {
                totalDelta += now - lastTime;
            }
            lastTime = now;
            frameCount += 1;

            if (frameCount >= sampleCount) {
                const denominator = Math.max(1, frameCount - 1);
                finish(totalDelta / denominator);
                return;
            }

            rafId = requestAnimationFrame(step);
        };

        const timeoutId = setTimeout(() => finish(16.7), timeoutMs);
        rafId = requestAnimationFrame(step);
    });
}

function detectSoftwareRenderer() {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) {
            return { isSoftware: true, reason: 'webgl-unavailable' };
        }

        let renderer = '';
        let vendor = '';
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');

        if (debugInfo) {
            renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '');
            vendor = String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || '');
        } else {
            renderer = String(gl.getParameter(gl.RENDERER) || '');
            vendor = String(gl.getParameter(gl.VENDOR) || '');
        }

        const renderInfo = `${renderer} ${vendor}`.toLowerCase();
        const softwareTokens = [
            'swiftshader',
            'software',
            'llvmpipe',
            'softpipe',
            'microsoft basic render',
            'mesa offscreen',
            'gdi generic',
            'rasterizer'
        ];

        const isSoftware = softwareTokens.some(token => renderInfo.includes(token));
        return {
            isSoftware,
            reason: isSoftware ? `software-renderer:${renderer || vendor || 'unknown'}` : 'hardware-renderer'
        };
    } catch (_) {
        return { isSoftware: false, reason: 'renderer-detect-error' };
    }
}

function schedulePerformanceRecheck() {
    if (performanceRecheckScheduled || isLowPerformanceMode) return;
    performanceRecheckScheduled = true;

    const runRecheck = async () => {
        if (isLowPerformanceMode) return;
        const avgFrameTime = await measureAverageFrameTime(30, 2600);
        if (avgFrameTime > 20) {
            enableLowPerformanceMode(`post-load-frame-time=${avgFrameTime.toFixed(1)}ms`);
        }
        initBackgroundIframe();
    };

    const launch = () => {
        setTimeout(() => {
            runRecheck().catch(err => console.warn('Performance recheck failed:', err));
        }, 900);
    };

    if (document.readyState === 'complete') {
        launch();
    } else {
        window.addEventListener('load', launch, { once: true });
    }
}

async function initializePerformanceMode() {
    const forcedMode = parseForcedLowPerformanceMode();
    if (forcedMode !== null) {
        if (forcedMode) {
            enableLowPerformanceMode('manual');
        }
        initBackgroundIframe();
        return;
    }

    const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cpuCores = Number(navigator.hardwareConcurrency || 0);
    const memoryGB = Number(navigator.deviceMemory || 0);
    const rendererProbe = detectSoftwareRenderer();

    if (prefersReducedMotion || (cpuCores > 0 && cpuCores <= 4) || (memoryGB > 0 && memoryGB <= 4)) {
        enableLowPerformanceMode('device-hints');
        initBackgroundIframe();
        return;
    }

    if (rendererProbe.isSoftware) {
        enableLowPerformanceMode(rendererProbe.reason);
        initBackgroundIframe();
        return;
    }

    const avgFrameTime = await measureAverageFrameTime(22, 1800);
    if (avgFrameTime > 22) {
        enableLowPerformanceMode(`startup-frame-time=${avgFrameTime.toFixed(1)}ms`);
    }

    initBackgroundIframe();
    schedulePerformanceRecheck();
}

// 延迟测试配置
const latencyTestConfig = {
    count: 16  // 采样和显示数量
};

// 追踪延迟显示的动画状态
const latencyUIState = {};

// 标记延迟测试是否已经开始，防止重复执行
let latencyTestStarted = false;
let latencyTestActive = false;
let latencyTestSessionId = 0;
let latencySiteLatencies = {};
let latencySiteIntervals = {};
let latencySiteUpdateInProgress = {};
const latencyFetchControllers = new Set();
const latencyFetchTimeoutMs = 8000;

// 延迟测试数据
const latencySites = [
    {
        name: '字节抖音',
        region: '国内',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#1677FF" d="m19.9 1.5 4.1 1v19l-4.1 1zM6.5 10.9l4.1 1v9l-4 1.1zM0 2.6l4.1 1v16.8l-4.1 1zm17.5 5.6v11.1l-4.2-1v-9z"></path></svg>',
        url: 'https://lf3-zlink-tos.ugurl.cn/obj/zebra-public/resource_lmmizj_1632398893.png'
    },
    {
        name: 'Bilibili',
        region: '国内',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#FB7299" d="M17.813 4.653h.854q2.266.08 3.773 1.574Q23.946 7.72 24 9.987v7.36q-.054 2.266-1.56 3.773c-1.506 1.507-2.262 1.524-3.773 1.56H5.333q-2.266-.054-3.773-1.56C.053 19.614.036 18.858 0 17.347v-7.36q.054-2.267 1.56-3.76t3.773-1.574h.774l-1.174-1.12a1.23 1.23 0 0 1-.373-.906q0-.534.373-.907l.027-.027q.4-.373.92-.373t.92.373L9.653 4.44q.107.106.187.213h4.267a.8.8 0 0 1 .16-.213l2.853-2.747q.4-.373.92-.373c.347 0 .662.151.929.4s.391.551.391.907q0 .532-.373.906zM5.333 7.24q-1.12.027-1.88.773q-.76.748-.786 1.894v7.52q.026 1.146.786 1.893t1.88.773h13.334q1.12-.026 1.88-.773t.786-1.893v-7.52q-.026-1.147-.786-1.894t-1.88-.773zM8 11.107q.56 0 .933.373q.375.374.4.96v1.173q-.025.586-.4.96q-.373.375-.933.374c-.56-.001-.684-.125-.933-.374q-.375-.373-.4-.96V12.44q0-.56.386-.947q.387-.386.947-.386m8 0q.56 0 .933.373q.375.374.4.96v1.173q-.025.586-.4.96q-.373.375-.933.374c-.56-.001-.684-.125-.933-.374q-.375-.373-.4-.96V12.44q.025-.586.4-.96q.373-.373.933-.373"></path></svg>',
        url: 'https://i0.hdslb.com/bfs/face/member/noface.jpg@24w_24h_1c'
    },
    {
        name: '腾讯微信',
        region: '国内',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#09B83E" d="M8.7 2.19C3.9 2.19 0 5.48 0 9.53c0 2.21 1.17 4.2 3 5.55a.6.6 0 0 1 .21.66l-.39 1.48q-.03.11-.04.22c0 .16.13.3.29.3a.3.3 0 0 0 .16-.06l1.9-1.11a.9.9 0 0 1 .72-.1 10 10 0 0 0 2.84.4q.41-.01.81-.05a5.85 5.85 0 0 1 1.93-6.45 8.3 8.3 0 0 1 5.86-1.83c-.58-3.59-4.2-6.35-8.6-6.35m-2.9 3.8c.64 0 1.16.53 1.16 1.18a1.17 1.17 0 0 1-1.16 1.18 1.17 1.17 0 0 1-1.17-1.18c0-.65.52-1.18 1.17-1.18m5.8 0c.65 0 1.17.53 1.17 1.18a1.17 1.17 0 0 1-1.16 1.18 1.17 1.17 0 0 1-1.16-1.18c0-.65.52-1.18 1.16-1.18m5.34 2.87a8 8 0 0 0-5.28 1.78 5.5 5.5 0 0 0-1.78 6.22c.94 2.46 3.66 4.23 6.88 4.23q1.25 0 2.36-.33a.7.7 0 0 1 .6.08l1.59.93.14.04c.13 0 .24-.1.24-.24q-.01-.09-.04-.18l-.33-1.23-.02-.16a.5.5 0 0 1 .2-.4 5.8 5.8 0 0 0 2.5-4.62c0-3.21-2.93-5.84-6.66-6.09zm-2.53 3.27c.53 0 .97.44.97.98a1 1 0 0 1-.97.99 1 1 0 0 1-.97-.99c0-.54.43-.98.97-.98zm4.84 0c.54 0 .97.44.97.98a1 1 0 0 1-.97.99 1 1 0 0 1-.97-.99c0-.54.44-.98.97-.98"></path></svg>',
        url: 'https://res.wx.qq.com/a/wx_fed/assets/res/NTI4MWU5.ico'
    },
    {
        name: '阿里淘宝',
        region: '国内',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#E16322" d="M21.31 9.9a3 3 0 1 1 0 1.92.96.96 0 0 1 0-1.92m2.39 3.05H13.3v-.96h4.14V9.76h-2.89v-.77h2.9v-.92h-2.52v.2H13.3v-2.9h1.64v.35l2.52-.3V4.6h1.85v.64c.93-.08 1.76-.13 2.21-.1 1.5.06 2.45.27 2.49 1.26.03 1-1.43 1.9-1.43 1.9l-.45-.43v.2h-2.8v.92h3.22v.77h-3.23v2.23h4.39zM21.53 7.3l-.02-.01s1.38-.76.35-1.27c-.87-.43-5.54.3-6.93.62v.66zM1.88 6.42a1 1 0 0 0 0-2 1 1 0 0 0-1 1 1 1 0 0 0 1 1m3.41-.86a7 7 0 0 0 .37-.72L4.2 4.42s-.6 1.93-1.65 2.83c0 0 1.02.6 1.01.58a10 10 0 0 0 .78-.88l.68-.3a9 9 0 0 1-1.14 1.69l.61.54s.42-.4.88-.9h.53v.9H3.86v.73H5.9v1.72h-.08c-.23-.01-.58-.05-.71-.27-.17-.26-.05-.75-.04-1.04h-1.4l-.06.02s-.52 2.32 1.5 2.27a5.3 5.3 0 0 0 3.46-.92l.2.76 1.17-.48-.79-1.92-.94.3.18.65a3 3 0 0 1-.82.42V9.6h2v-.72h-2v-.9h2v-.72H6.01c.26-.31.46-.6.51-.78l-.62-.17c2.67-.95 4.15-.79 4.13.77v4.12s.16 1.4-1.46 1.3l-.87-.18-.21.83s3.78 1.08 4.1-1.82-.09-4.76-.09-4.76-.34-2.68-6.2-1.02zm-5.23 6.6 1.58.98c1.1-2.38 1.03-2.06 1.3-2.92.29-.87.35-1.54-.13-2.02a10 10 0 0 0-1.6-1.36L.55 7.86l1.21.75s.82.42.43 1.2c-.36.73-2.13 2.34-2.13 2.34M20 19s-.02.53-.67.53c-.6 0-.64-.42-.64-.42q-.39.45-1.07.46c-.76 0-1.3-.51-1.3-1.3 0-.78.56-1.27 1.4-1.27.39 0 .73.15.93.4l.01-.2c0-.56-.3-.8-1-.8q-.51 0-1.02.13.16-.33.3-.45.18-.14.94-.14c1.27 0 1.74.42 1.74 1.42v1.2c0 .32.03.44.38.44m-1.33-.74c0-.48-.25-.75-.64-.75-.4 0-.66.28-.66.76 0 .47.27.76.65.76.39 0 .65-.27.65-.77m5.27-.5c0 1.15-.7 1.82-1.78 1.82-1.1 0-1.77-.67-1.77-1.82 0-1.16.68-1.83 1.77-1.83s1.78.67 1.78 1.83m-1.08 0q0-1.3-.7-1.3t-.69 1.3.7 1.3.69-1.3m-7.14-.05c0 1.17-.65 1.86-1.57 1.86q-.66-.01-1.05-.47s-.1.42-.66.42c-.69 0-.67-.52-.67-.52.4.02.38-.21.38-.43v-2.89c0-.36-.07-.48-.43-.49.02-.1.08-.53.68-.53.82 0 .76.91.76.91v.79q.34-.4 1-.4c.96 0 1.56.65 1.56 1.75m-1.09.08q-.01-1.35-.76-1.35c-.44 0-.74.4-.74 1.1v.36c0 .72.31 1.12.76 1.12q.73 0 .74-1.23m-3.24-.03c0 1.15-.7 1.82-1.78 1.82-1.1 0-1.78-.67-1.78-1.82 0-1.16.68-1.83 1.78-1.83s1.78.67 1.78 1.83m-1.09 0q0-1.3-.7-1.3-.69 0-.68 1.3t.69 1.3q.7 0 .7-1.3m-6-2.72q-.4.11-1.55.1-1.38-.02-1.85-.04c-.52 0-.73.13-.91.66q.45-.13 1.13-.11c.36 0 .42.04.42.3v2.9c0 .28.11.67.72.67.71 0 .84-.52.84-.52-.36 0-.43-.13-.43-.49v-2.56c0-.27.1-.28.47-.28h.26c.55 0 .7-.1.9-.63M7.46 19s-.02.52-.67.52c-.56 0-.64-.4-.64-.4q-.39.45-1.07.45c-.76 0-1.3-.52-1.3-1.3S4.33 17 5.17 17c.39 0 .73.14.93.4v-.2c0-.56-.3-.8-1-.8q-.5 0-1.01.13.15-.33.3-.46.17-.14.94-.14c1.26 0 1.74.43 1.74 1.43v1.2c0 .32.03.44.38.44m-1.33-.75c0-.48-.26-.74-.64-.74-.4 0-.67.28-.67.76 0 .46.28.76.66.76.39 0 .65-.28.65-.78"></path></svg>',
        url: 'https://img.alicdn.com/imgextra/i2/O1CN01qnQCrN1VkzAWiU4Hs_!!6000000002692-2-tps-33-33.png'
    },
    {
        name: 'GitHub',
        region: '国际',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#181717" d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.7 4.7 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .31.2.69.82.57A12 12 0 0 0 12 .3"></path></svg>',
        url: 'https://github.github.io/janky/images/bg_hr.png'
    },
    {
        name: 'Telegram',
        region: '国际',
        icon: '<svg width="24px" height="24px" viewBox="0 0 16 16" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient x1="50%" y1="0%" x2="50%" y2="100%" id="linearGradient-1"><stop stop-color="#38AEEB" offset="0%"></stop><stop stop-color="#279AD1" offset="100%"></stop></linearGradient></defs><g id="Artboard" stroke="none" stroke-width="1" fill="none" fill-rule="evenodd"><circle id="Oval" fill="url(#linearGradient-1)" cx="8" cy="8" r="8"></circle><path d="M3.17026167,7.83635602 C5.78750201,6.74265999 7.53273882,6.02162863 8.40597211,5.67326193 C10.8992306,4.67860423 11.2454541,4.53439191 11.5831299,4.52864956 C11.6573986,4.52743168 11.8385417,4.55776042 11.9798438,4.67645833 C12.1211458,4.79515625 12.1635786,4.87206678 12.1755371,4.93908691 C12.1874957,5.00610705 12.1862759,5.21456762 12.1744385,5.3338623 C12.0393279,6.69547283 11.5259342,9.83829771 11.2285121,11.3633248 C11.1026617,12.008621 10.8548582,12.2249854 10.6149558,12.2461596 C10.0935924,12.2921758 9.69769267,11.9156852 9.19272668,11.5981993 C8.40255458,11.1013965 8.13911734,10.9180161 7.3721185,10.4332283 C6.48571864,9.87297217 6.85080034,9.6784879 7.35595703,9.17524981 C7.48815894,9.04355001 9.67825076,7.04590073 9.71077046,6.86250183 C9.7391276,6.70257812 9.7494847,6.68189389 9.67664063,6.60973958 C9.60379655,6.53758527 9.51674192,6.54658941 9.46083149,6.55876051 C9.38158015,6.57601267 8.17521836,7.33962686 5.84174612,8.84960308 C5.48344358,9.08558775 5.15890428,9.20056741 4.86812819,9.19454205 C4.54757089,9.18789957 3.93094724,9.02070014 3.47255094,8.87778221 C2.91030922,8.70248755 2.46345069,8.609808 2.50236203,8.31210343 C2.52262946,8.15704047 2.74526267,7.998458 3.17026167,7.83635602 Z" id="Path-3" fill="#FFFFFF"></path></g></svg>',
        url: 'https://web.telegram.org/k/'
    },
    {
        name: 'X.com',
        region: '国际',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#1DA1F2" d="M23.643 4.937c-.835.37-1.732.62-2.675.733.962-.576 1.7-1.49 2.048-2.578-.9.534-1.897.922-2.958 1.13-.85-.904-2.06-1.47-3.4-1.47-2.572 0-4.658 2.086-4.658 4.66 0 .364.042.718.12 1.06-3.873-.195-7.304-2.05-9.602-4.868-.4.69-.63 1.49-.63 2.342 0 1.616.823 3.043 2.072 3.878-.764-.025-1.482-.234-2.11-.583v.06c0 2.257 1.605 4.14 3.737 4.568-.392.106-.803.162-1.227.162-.3 0-.593-.028-.877-.082.594 1.85 2.323 3.196 4.368 3.233-1.595 1.25-3.604 1.995-5.786 1.995-.376 0-.747-.022-1.112-.065 2.072 1.328 4.532 2.104 7.172 2.104 8.607 0 13.3-7.132 13.3-13.3 0-.202-.005-.403-.014-.602.913-.66 1.706-1.477 2.332-2.41z"></path></svg>',
        url: 'https://abs.twimg.com/favicons/twitter.3.ico'
    },
    {
        name: 'YouTube',
        region: '国际',
        icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#FF0000" d="M23.5 6.19a3 3 0 0 0-2.12-2.14c-1.87-.5-9.38-.5-9.38-.5s-7.5 0-9.38.5A3 3 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3 3 0 0 0 2.12 2.14c1.87.5 9.38.5 9.38.5s7.5 0 9.38-.5a3 3 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81M9.55 15.57V8.43L15.82 12z"></path></svg>',
        url: 'https://www.youtube.com/favicon.ico'
    }
];

// 初始化主题
function initializeTheme() {
    const saved = localStorage.getItem('theme');
    let theme = saved;

    // 如果第一次打开，按系统主题决定
    if (!saved) {
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    applyTheme(theme);
}

// 应用主题
function applyTheme(theme) {
    if (theme === 'dark') {
        document.documentElement.classList.add('dark-mode');
        localStorage.setItem('theme', 'dark');
        document.getElementById('themeToggle').title = '切换日间模式';
    } else {
        document.documentElement.classList.remove('dark-mode');
        localStorage.setItem('theme', 'light');
        document.getElementById('themeToggle').title = '切换夜间模式';
    }
}

// 生成延迟卡片
function generateLatencyCards() {
    const container = document.getElementById('latency-cards');
    if (!container) return;
    container.innerHTML = '';

    // 按地区排序：国内优先，然后国际
    const sortedSites = [...latencySites].sort((a, b) => {
        const aIsChina = a.region === '国内' ? 0 : 1;
        const bIsChina = b.region === '国内' ? 0 : 1;
        return aIsChina - bIsChina;
    });

    sortedSites.forEach(site => {
        const card = document.createElement('div');
        card.className = 'latency-card';
        const siteName = site.name.toLowerCase().replace(/\s+/g, '-');
        card.innerHTML = `
            <div class="latency-card-header">
                <div class="latency-card-info">
                    <div class="latency-card-icon-wrapper" data-site="${siteName}">
                        ${site.icon}
                    </div>
                    <div class="latency-card-text">
                        <span class="latency-card-name">${site.name}</span>
                        <span class="latency-card-region" data-region="${site.region}">${site.region}</span>
                    </div>
                </div>
                <div class="latency-status" id="latency-${siteName}">...<span class="unit">ms</span></div>
            </div>
            <div class="latency-graph-container">
                <div class="graph-grid"></div>
                <svg class="latency-ecg" viewBox="0 0 400 60" preserveAspectRatio="none">
                    <path class="ecg-path-bg" d="M0,30 L400,30"></path>
                    <path class="ecg-path" id="path-${siteName}" d="M0,30 L400,30"></path>
                    <circle class="ecg-cursor" id="cursor-${siteName}" r="3" cx="0" cy="30" style="display:none"></circle>
                </svg>
            </div>
        `;
        container.appendChild(card);
    });
}

// 测试延迟
async function testLatency(site) {
    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), latencyFetchTimeoutMs);
    latencyFetchControllers.add(controller);

    try {
        await fetch(site.url + '?t=' + Date.now(), {
            method: 'HEAD',
            cache: 'no-cache',
            mode: 'no-cors',
            referrerPolicy: 'no-referrer',
            signal: controller.signal
        });
        const latency = Date.now() - start;
        return latency;
    } catch (error) {
        return -1; // 连接失败
    } finally {
        clearTimeout(timeoutId);
        latencyFetchControllers.delete(controller);
    }
}

function initLatencyDataStorage() {
    if (Object.keys(latencySiteLatencies).length > 0) return;

    latencySites.forEach(site => {
        const siteName = site.name.toLowerCase().replace(/\s+/g, '-');
        latencySiteLatencies[siteName] = [];
    });
}

function stopLatencyTest() {
    latencyTestActive = false;
    latencyTestSessionId += 1;

    Object.values(latencySiteIntervals).forEach(timer => clearInterval(timer));
    latencySiteIntervals = {};
    latencySiteUpdateInProgress = {};

    latencyFetchControllers.forEach(controller => controller.abort());
    latencyFetchControllers.clear();

    Object.values(latencyUIState).forEach(state => {
        if (state && state.timer) {
            clearInterval(state.timer);
            state.timer = null;
        }
    });
}

// 获取延迟颜色
function getLatencyColor(latency) {
    if (latency === -1) return 'var(--destructive)';
    if (latency <= 49) return 'var(--latency-49)';
    if (latency <= 149) return 'var(--latency-149)';
    if (latency <= 299) return 'var(--latency-299)';
    if (latency <= 999) return 'var(--latency-999)';
    return 'var(--latency-1000)';
}

// 更新延迟显示
function updateLatencyDisplay(siteName, latencies) {
    const valueElement = document.getElementById(`latency-${siteName}`);
    const pathElement = document.getElementById(`path-${siteName}`);
    const cursorElement = document.getElementById(`cursor-${siteName}`);

    if (!valueElement || !pathElement) return;

    // 计算平均延迟
    const lastLatency = latencies[latencies.length - 1];
    const validLatencies = latencies.filter(l => l !== -1);
    let avgLatency = -1;

    if (validLatencies.length > 0) {
        // 如果有足够的数据，去掉最高和最低延迟以获得更稳定的平均值
        if (validLatencies.length > 5) {
            const sorted = [...validLatencies].sort((a, b) => a - b);
            const trimmed = sorted.slice(1, -1);
            avgLatency = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
        } else {
            avgLatency = validLatencies.reduce((a, b) => a + b, 0) / validLatencies.length;
        }
    }

    const targetValue = Math.round(avgLatency);

    // 更新文字显示
    if (validLatencies.length === 0) {
        if (lastLatency === -1) {
            valueElement.innerHTML = 'TIMEOUT';
            valueElement.style.color = 'var(--latency-999)';
        } else {
            valueElement.innerHTML = '...<span class="unit">ms</span>';
            valueElement.style.color = '#f6821f';
        }
    } else {
        const siteState = latencyUIState[siteName] || { current: targetValue, timer: null };
        latencyUIState[siteName] = siteState;

        // 设置颜色
        const avgColor = getLatencyColor(targetValue);
        valueElement.style.color = avgColor;

        // 如果数值变化较小，直接显示
        if (isLowPerformanceMode) {
            if (siteState.timer) {
                clearInterval(siteState.timer);
                siteState.timer = null;
            }
            siteState.current = targetValue;
            valueElement.innerHTML = `${targetValue}<span class="unit">ms</span>`;
        } else if (Math.abs(siteState.current - targetValue) < 2) {
            siteState.current = targetValue;
            valueElement.innerHTML = `${targetValue}<span class="unit">ms</span>`;
        } else {
            // 清除旧的计时器
            if (siteState.timer) clearInterval(siteState.timer);

            // 每 30ms 更新一次数字，实现滚动的动态效果
            const step = () => {
                if (siteState.current < targetValue) {
                    siteState.current += Math.ceil((targetValue - siteState.current) / 5);
                } else if (siteState.current > targetValue) {
                    siteState.current -= Math.ceil((siteState.current - targetValue) / 5);
                }

                valueElement.innerHTML = `${siteState.current}<span class="unit">ms</span>`;

                if (siteState.current === targetValue) {
                    clearInterval(siteState.timer);
                    siteState.timer = null;
                }
            };

            siteState.timer = setInterval(step, 30);
        }
    }

    // 更新 SVG 路径
    const width = 400;
    const height = 60;
    const padding = 10;
    const step = width / (latencyTestConfig.count - 1);

    let points = [];
    latencies.forEach((l, i) => {
        const x = i * step;
        let y;
        if (l === -1) {
            y = height - 5;
        } else {
            // 映射 0-500ms 到高度，高延迟在上，低延迟在下？通常ECG是越高表示值越大或者越快？
            // demo里是 height - padding - (Math.min(l, 500) / 500 * (height - 2 * padding))
            // 这意味着延迟越低，y越大（越靠下）。延迟越高，y越小（越靠上）。
            y = height - padding - (Math.min(l, 500) / 800 * (height - 2 * padding));
        }
        points.push({ x, y });
    });

    if (points.length > 0) {
        // 生成平滑曲线路径 (Bezier)
        let d = `M${points[0].x},${points[0].y}`;
        for (let i = 0; i < points.length - 1; i++) {
            const x_mid = (points[i].x + points[i + 1].x) / 2;
            const y_mid = (points[i].y + points[i + 1].y) / 2;
            d += ` Q${points[i].x},${points[i].y} ${x_mid},${y_mid}`;
        }
        const lastPoint = points[points.length - 1];
        d += ` L${lastPoint.x},${lastPoint.y}`;

        pathElement.setAttribute('d', d);
        const avgColor = getLatencyColor(targetValue);
        pathElement.style.stroke = avgColor;

        // 更新光标位置
        if (cursorElement) {
            cursorElement.style.display = 'block';
            cursorElement.setAttribute('cx', lastPoint.x);
            cursorElement.setAttribute('cy', lastPoint.y);
            cursorElement.style.fill = avgColor;
        }
    }
}

// 开始延迟测试
async function startLatencyTest() {
    if (latencyTestActive) return;

    latencyTestActive = true;
    const currentSessionId = ++latencyTestSessionId;

    Object.values(latencySiteIntervals).forEach(timer => clearInterval(timer));
    latencySiteIntervals = {};
    latencySiteUpdateInProgress = {};

    if (!latencyTestStarted) {
        generateLatencyCards();
        latencyTestStarted = true;
    }

    initLatencyDataStorage();

    latencySites.forEach(site => {
        startSingleSiteLatencyLoop(site, currentSessionId);
    });
}

async function startSingleSiteLatencyLoop(site, sessionId) {
    const siteName = site.name.toLowerCase().replace(/\s+/g, '-');

    while (
        latencyTestActive &&
        sessionId === latencyTestSessionId &&
        latencySiteLatencies[siteName].length < latencyTestConfig.count
    ) {
        const latency = await testLatency(site);
        if (!latencyTestActive || sessionId !== latencyTestSessionId) return;

        latencySiteLatencies[siteName].push(latency);
        updateLatencyDisplay(siteName, latencySiteLatencies[siteName]);
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (!latencyTestActive || sessionId !== latencyTestSessionId) return;

    if (latencySiteIntervals[siteName]) {
        clearInterval(latencySiteIntervals[siteName]);
        delete latencySiteIntervals[siteName];
    }

    latencySiteIntervals[siteName] = setInterval(async () => {
        if (
            !latencyTestActive ||
            sessionId !== latencyTestSessionId ||
            latencySiteUpdateInProgress[siteName]
        ) {
            return;
        }

        latencySiteUpdateInProgress[siteName] = true;
        try {
            const latency = await testLatency(site);
            if (!latencyTestActive || sessionId !== latencyTestSessionId) return;

            latencySiteLatencies[siteName].push(latency);
            if (latencySiteLatencies[siteName].length > latencyTestConfig.count) {
                latencySiteLatencies[siteName].shift();
            }
            updateLatencyDisplay(siteName, latencySiteLatencies[siteName]);
        } finally {
            latencySiteUpdateInProgress[siteName] = false;
        }
    }, 618 * 3);
}

// 切换主题
function toggleTheme() {
    const isDark = document.documentElement.classList.contains('dark-mode');
    applyTheme(isDark ? 'light' : 'dark');
}

// 返回顶部
function scrollToTop() {
    const pageWrapper = document.querySelector('.page-wrapper');
    const behavior = isLowPerformanceMode ? 'auto' : 'smooth';
    if (pageWrapper) {
        pageWrapper.scrollTo({ top: 0, behavior });
    } else {
        window.scrollTo({ top: 0, behavior });
    }
}

function updateVersionBadge(version) {
    const versionBadge = document.getElementById('versionBadge');
    const versionValue = document.getElementById('versionValue');
    if (!versionBadge || !versionValue) return;

    versionBadge.classList.remove('is-latest', 'is-outdated', 'is-preview');

    const rawText = String(version ?? '').trim();
    const digitsOnly = rawText.replace(/\D/g, '');
    const text = digitsOnly || rawText;
    if (text) {
        cachedCurrentVersionFullText = text;
        cachedCurrentVersionNumber = parseVersionNumber(text);
        const shortText = text.slice(0, 8);
        versionValue.textContent = "v2.1." + shortText;
        versionBadge.dataset.health = '';
        versionBadge.hidden = false;
        versionBadge.style.display = 'flex';
        versionBadge.title = `当前版本: ${versionValue.textContent}`;
    } else {
        versionValue.textContent = '';
        cachedCurrentVersionNumber = 0;
        cachedCurrentVersionFullText = '';
        versionBadge.dataset.health = '';
        versionBadge.hidden = true;
        versionBadge.style.display = 'none';
        versionBadge.title = '当前版本';
    }
}

function parseVersionNumber(value) {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (!digits) return 0;
    const parsed = Number(digits);
    return Number.isFinite(parsed) ? parsed : 0;
}

function setHttpsProxyFeatureAvailability(currentVersion) {
    httpsProxyFeatureEnabled = parseVersionNumber(currentVersion) >= HTTPS_PROXY_MIN_VERSION;

    const httpsOption = document.getElementById('httpsProxyOption');
    if (httpsOption) {
        httpsOption.hidden = !httpsProxyFeatureEnabled;
        httpsOption.style.display = httpsProxyFeatureEnabled ? '' : 'none';
    }

    const proxyMode = document.getElementById('proxyMode');
    if (!proxyMode) return;

    if (!httpsProxyFeatureEnabled && proxyMode.value === 'https') {
        proxyMode.value = 'http';
        updateProxyMode(false);
        return;
    }

    if (proxyMode.value === 'https') {
        updateProxyMode(false);
    }
}

function getVersionHealthMeta(healthKey) {
    if (healthKey === 'latest') {
        return {
            titleSuffix: '已是最新',
            summaryClass: 'state-latest',
            tipClass: 'is-latest',
            tipText: '已是最新'
        };
    }
    if (healthKey === 'preview') {
        return {
            titleSuffix: '测试版',
            summaryClass: 'state-preview',
            tipClass: 'is-preview',
            tipText: '测试版'
        };
    }
    return {
        titleSuffix: '需要更新',
        summaryClass: 'state-outdated',
        tipClass: 'is-outdated',
        tipText: '需要更新'
    };
}

function applyVersionInfoHealthState(healthKey) {
    const summaryEl = document.getElementById('versionInfoSummary');
    const stateTextEl = document.getElementById('currentVersionStateText');
    if (!summaryEl || !stateTextEl) return;

    const meta = getVersionHealthMeta(healthKey);
    summaryEl.classList.remove('state-latest', 'state-outdated', 'state-preview');
    stateTextEl.classList.remove('is-latest', 'is-outdated', 'is-preview');
    summaryEl.classList.add(meta.summaryClass);
    stateTextEl.classList.add(meta.tipClass);
    stateTextEl.textContent = meta.tipText;
}

function setVersionBadgeHealthState(diff) {
    const versionBadge = document.getElementById('versionBadge');
    const versionValue = document.getElementById('versionValue');
    if (!versionBadge) return;

    let healthKey = 'outdated';
    if (diff === 0) {
        healthKey = 'latest';
    } else if (diff > 0) {
        healthKey = 'preview';
    }
    const meta = getVersionHealthMeta(healthKey);

    versionBadge.classList.remove('is-latest', 'is-outdated', 'is-preview');
    if (healthKey === 'latest') {
        versionBadge.classList.add('is-latest');
    } else if (healthKey === 'outdated') {
        versionBadge.classList.add('is-outdated');
    } else {
        versionBadge.classList.add('is-preview');
    }
    versionBadge.dataset.health = healthKey;
    versionBadge.title = `当前版本: ${versionValue?.textContent || ''} ${meta.titleSuffix}`;
    applyVersionInfoHealthState(healthKey);
}

async function fetchLatestOnlineVersionNumber() {
    cachedWorkerVersionRawText = '';
    cachedLatestOnlineVersion = 0;

    try {
        const workerText = await fetchWithAutoMirror(WORKER_VERSION_SOURCE_URL + '?_t=' + Date.now(), 'Worker 主程序');
        cachedWorkerVersionRawText = workerText;

        const versionMatch = workerText.match(/^\s*const\s+Version\s*=\s*['"]([^'"]+)['"]\s*;?/m);
        const latestVersion = versionMatch ? parseVersionNumber(versionMatch[1]) : 0;
        cachedLatestOnlineVersion = latestVersion;
        console.log(`[Version] 在线最新版本识别: raw="${versionMatch ? versionMatch[1] : ''}", parsed=${latestVersion}`);
        return latestVersion;
    } catch (error) {
        console.warn('[Version] 在线获取最新版本失败，按 0 处理:', error);
        cachedLatestOnlineVersion = 0;
        return 0;
    }
}

async function updateVersionBadgeHealthByLatest(currentVersion) {
    const currentVersionNumber = parseVersionNumber(currentVersion);
    const latestVersionNumber = await fetchLatestOnlineVersionNumber();
    const diff = currentVersionNumber - latestVersionNumber;
    console.log(`[Version] 版本比较: current=${currentVersionNumber}, latest=${latestVersionNumber}, diff=${diff}`);
    setVersionBadgeHealthState(diff);
}

async function loadVersionByUUID(uuid) {
    const uuidValue = String(uuid || '').trim();
    if (!uuidValue) {
        updateVersionBadge(0);
        setHttpsProxyFeatureAvailability(0);
        await updateVersionBadgeHealthByLatest(0);
        return;
    }

    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(`/version?_t=${Date.now()}&uuid=${encodeURIComponent(uuidValue)}`, {
                method: 'GET',
                headers: {
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            if (!data || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, 'Version')) {
                throw new Error('missing Version field');
            }

            const currentVersion = parseVersionNumber(data.Version);
            console.log(`[Version] 当前版本识别: raw="${data.Version}", parsed=${currentVersion}, attempt=${attempt}/${maxRetries}`);
            updateVersionBadge(currentVersion);
            setHttpsProxyFeatureAvailability(currentVersion);
            await updateVersionBadgeHealthByLatest(currentVersion);
            return;
        } catch (error) {
            lastError = error;
            console.warn(`[Version] 获取版本号失败(第${attempt}/${maxRetries}次):`, error);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }
    }

    console.warn('[Version] 获取版本号重试3次仍失败，按 0 处理:', lastError);
    updateVersionBadge(0);
    setHttpsProxyFeatureAvailability(0);
    await updateVersionBadgeHealthByLatest(0);
}

function onVersionBadgeKeydown(event) {
    if (!event) return;
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openVersionInfoModal();
    }
}

function openVersionInfoModal() {
    const versionBadge = document.getElementById('versionBadge');
    const versionValue = document.getElementById('versionValue');
    const modal = document.getElementById('versionInfoModal');
    const latestVersionValueEl = document.getElementById('latestVersionInfoValue');
    const currentVersionValueEl = document.getElementById('currentVersionInfoValue');
    if (!versionBadge || !versionValue || !modal || !latestVersionValueEl || !currentVersionValueEl) return;
    if (versionBadge.hidden || versionBadge.style.display === 'none') return;

    const currentVersionFullText = cachedCurrentVersionFullText || String(versionValue.textContent || '').replace(/^v2\.1\./, '');
    const currentVersion = parseVersionNumber(currentVersionFullText);
    const latestVersion = cachedLatestOnlineVersion || 0;
    latestVersionValueEl.textContent = `v2.1.${latestVersion}`;
    currentVersionValueEl.textContent = `v2.1.${currentVersionFullText || currentVersion || 0}`;

    let healthKey = versionBadge.dataset.health || '';
    if (!healthKey) {
        if (versionBadge.classList.contains('is-latest')) {
            healthKey = 'latest';
        } else if (versionBadge.classList.contains('is-preview')) {
            healthKey = 'preview';
        } else {
            healthKey = 'outdated';
        }
    }
    applyVersionInfoHealthState(healthKey);
    modal.classList.add('show');
}

function closeVersionInfoModal(event) {
    if (event && event.target.id !== 'versionInfoModal') return;
    const modal = document.getElementById('versionInfoModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

async function copyLatestWorkerSourceToClipboard() {
    const source = String(cachedWorkerVersionRawText || '');
    if (!source) {
        showToast('暂无可复制的最新 Worker.js 源码', 'error');
        return;
    }

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(source);
        } else {
            const tempTextarea = document.createElement('textarea');
            tempTextarea.value = source;
            tempTextarea.style.position = 'fixed';
            tempTextarea.style.opacity = '0';
            tempTextarea.style.left = '-9999px';
            tempTextarea.style.top = '0';
            document.body.appendChild(tempTextarea);
            tempTextarea.focus();
            tempTextarea.select();
            const success = document.execCommand('copy');
            document.body.removeChild(tempTextarea);
            if (!success) throw new Error('execCommand copy failed');
        }

        showToast('✅ 已复制最新 Worker.js 源码到剪贴板', 'success');
    } catch (error) {
        console.error('[Version] 复制最新 Worker.js 源码失败:', error);
        showToast('复制失败，请手动复制源码', 'error');
    }
}

function openLatestPagesZipDownload() {
    const popup = window.open(PAGES_ZIP_DOWNLOAD_URL, '_blank', 'noopener,noreferrer');
    if (!popup) {
        showToast('浏览器拦截了新窗口，请允许弹窗后再试', 'warning');
    }
}

function escapeMarkdownHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeHttpUrl(urlText) {
    try {
        const parsed = new URL(String(urlText || '').trim(), window.location.href);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.href;
        }
    } catch (_) {
        // ignore invalid URLs
    }
    return '';
}

function renderChangelogInline(rawText) {
    const formatInlineText = (text) => {
        return escapeMarkdownHtml(text)
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code>$1</code>');
    };

    const source = String(rawText ?? '');
    const linkPattern = /\[([^\]]+)\]\(([^)\s]+)\)/g;
    let html = '';
    let cursor = 0;
    let match = null;

    while ((match = linkPattern.exec(source)) !== null) {
        const [fullMatch, label, href] = match;
        html += formatInlineText(source.slice(cursor, match.index));

        const safeHref = sanitizeHttpUrl(href);
        if (safeHref) {
            html += `<a href="${escapeMarkdownHtml(safeHref)}" target="_blank" rel="noopener">${formatInlineText(label)}</a>`;
        } else {
            html += formatInlineText(fullMatch);
        }

        cursor = match.index + fullMatch.length;
    }

    html += formatInlineText(source.slice(cursor));
    return html;
}

function buildVersionMatchCandidates(value) {
    const set = new Set();
    const raw = String(value ?? '').trim();
    if (!raw) return set;

    const digits = raw.replace(/\D/g, '');
    if (digits) {
        set.add(digits);
        if (digits.length === 14) {
            set.add(`21${digits}`);
        }
        if (digits.startsWith('21') && digits.length > 2) {
            set.add(digits.slice(2));
        }
    }

    const versionBodyMatch = raw.match(/(?:^|v)2\.1\.(\d+)/i);
    if (versionBodyMatch && versionBodyMatch[1]) {
        set.add(versionBodyMatch[1]);
        set.add(`21${versionBodyMatch[1]}`);
    }

    return set;
}

function parseChangelogVersionHeading(headingText) {
    const source = String(headingText ?? '').trim();
    const match = source.match(/^\[([^\]]+)\](?:\s*-\s*(.+))?$/);

    if (!match) {
        return {
            versionText: source,
            dateText: '',
            candidates: buildVersionMatchCandidates(source)
        };
    }

    const versionText = String(match[1] || '').trim();
    const dateText = String(match[2] || '').trim();
    return {
        versionText,
        dateText,
        candidates: buildVersionMatchCandidates(versionText)
    };
}

function resolveCurrentVersionDisplayText() {
    const currentVersionInfoEl = document.getElementById('currentVersionInfoValue');
    const fromInfo = String(currentVersionInfoEl?.textContent || '').trim();
    if (fromInfo) return fromInfo;
    if (cachedCurrentVersionFullText) return `v2.1.${cachedCurrentVersionFullText}`;
    return '';
}

function isCurrentVersionMatched(currentCandidates, headingCandidates) {
    if (!currentCandidates || currentCandidates.size === 0) return false;
    if (!headingCandidates || headingCandidates.size === 0) return false;

    for (const candidate of headingCandidates) {
        if (currentCandidates.has(candidate)) {
            return true;
        }
    }
    return false;
}

function getChangelogSubheadingMeta(rawHeadingText) {
    const normalized = String(rawHeadingText ?? '').trim().toLowerCase();
    const 新增功能 = ['新增功能', 'added', 'add', 'new'].map(s => s.toLowerCase());
    const 问题修复 = ['问题修复', 'debug', 'bug', 'fixed', 'fix'].map(s => s.toLowerCase());
    const 功能改进 = ['功能改进', 'enhancement', 'improve', 'improvement', 'optimize', 'optimization', 'change', 'changed'].map(s => s.toLowerCase());
    const 功能移除 = ['功能移除', 'delete', 'deleted', 'remove', 'removed', 'removal'].map(s => s.toLowerCase());
    if (新增功能.includes(normalized)) {
        return {
            type: 'new',
            label: '新增功能',
            icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-plus w-4 h-4"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>`
        };
    }
    if (问题修复.includes(normalized)) {
        return {
            type: 'debug',
            label: '问题修复',
            icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bug w-4 h-4"><path d="m8 2 1.88 1.88"></path><path d="M14.12 3.88 16 2"></path><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"></path><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"></path><path d="M12 20v-9"></path><path d="M6.53 9C4.6 8.8 3 7.1 3 5"></path><path d="M6 13H2"></path><path d="M3 21c0-2.1 1.7-3.9 3.8-4"></path><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"></path><path d="M22 13h-4"></path><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"></path></svg>`
        };
    }
    if (功能改进.includes(normalized)) {
        return {
            type: 'improve',
            label: '功能改进',
            icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-refresh-cw w-4 h-4"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>`
        };
    }
    if (功能移除.includes(normalized)) {
        return {
            type: 'delete',
            label: '功能移除',
            icon: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2 w-4 h-4"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>`
        };
    }
    return null;
}

function renderChangelogSubheading(rawHeadingText, resolvedMeta = null) {
    const meta = resolvedMeta || getChangelogSubheadingMeta(rawHeadingText);
    if (!meta) {
        return `<h4>${renderChangelogInline(rawHeadingText)}</h4>`;
    }
    return `<h4 class="changelog-subtitle is-${meta.type}"><span class="changelog-subtitle-icon">${meta.icon}</span><span class="changelog-subtitle-text">${escapeMarkdownHtml(meta.label)}</span></h4>`;
}

function renderChangelogSectionBody(sectionLines) {
    const htmlParts = [];
    let inList = false;
    let currentSubtitleType = '';

    const closeList = () => {
        if (inList) {
            htmlParts.push('</ul>');
            inList = false;
        }
    };

    for (const rawLine of sectionLines) {
        const line = String(rawLine ?? '').trim();
        if (!line) {
            closeList();
            continue;
        }

        let match = line.match(/^###\s+(.+)$/);
        if (match) {
            closeList();
            const subtitleMeta = getChangelogSubheadingMeta(match[1]);
            currentSubtitleType = subtitleMeta ? subtitleMeta.type : '';
            htmlParts.push(renderChangelogSubheading(match[1], subtitleMeta));
            continue;
        }

        match = line.match(/^-\s+(.+)$/);
        if (match) {
            if (!inList) {
                const listClassName = currentSubtitleType
                    ? `changelog-sublist is-${currentSubtitleType}`
                    : 'changelog-sublist';
                htmlParts.push(`<ul class="${listClassName}">`);
                inList = true;
            }
            htmlParts.push(`<li>${renderChangelogInline(match[1])}</li>`);
            continue;
        }

        closeList();
        htmlParts.push(`<p>${renderChangelogInline(line)}</p>`);
    }

    closeList();
    return htmlParts.join('');
}

function renderChangelogMarkdown(markdownText) {
    const lines = String(markdownText ?? '').replace(/\r\n?/g, '\n').split('\n');
    const htmlParts = [];
    let versionEntryCount = 0;
    let currentVersionPosition = 0;
    let currentVersionHeadingText = '';

    const currentVersionDisplayText = resolveCurrentVersionDisplayText();
    const currentVersionCandidates = buildVersionMatchCandidates(
        currentVersionDisplayText || cachedCurrentVersionFullText
    );

    const sections = [];
    let currentSection = null;
    const prefaceLines = [];

    for (const rawLine of lines) {
        const trimmedLine = String(rawLine ?? '').trim();
        const versionMatch = trimmedLine.match(/^##\s+(.+)$/);

        if (versionMatch) {
            if (currentSection) {
                sections.push(currentSection);
            }
            currentSection = {
                heading: versionMatch[1],
                bodyLines: []
            };
            continue;
        }

        if (currentSection) {
            currentSection.bodyLines.push(rawLine);
        } else {
            prefaceLines.push(rawLine);
        }
    }

    if (currentSection) {
        sections.push(currentSection);
    }

    const prefaceHtml = renderChangelogSectionBody(prefaceLines);
    if (prefaceHtml) {
        htmlParts.push(prefaceHtml);
    }

    const sectionMetaList = sections.map(section => {
        const parsedHeading = parseChangelogVersionHeading(section.heading);
        return {
            section,
            parsedHeading,
            versionNumber: parseVersionNumber(parsedHeading.versionText)
        };
    });

    let latestVersionNumberInChangelog = 0;
    for (const sectionMeta of sectionMetaList) {
        if (sectionMeta.versionNumber > latestVersionNumberInChangelog) {
            latestVersionNumberInChangelog = sectionMeta.versionNumber;
        }
    }

    for (const sectionMeta of sectionMetaList) {
        versionEntryCount += 1;
        const { section, parsedHeading, versionNumber } = sectionMeta;
        const isCurrent = isCurrentVersionMatched(currentVersionCandidates, parsedHeading.candidates);
        const isLatest = latestVersionNumberInChangelog > 0
            ? versionNumber === latestVersionNumberInChangelog
            : versionEntryCount === 1;

        if (isCurrent && !currentVersionPosition) {
            currentVersionPosition = versionEntryCount;
            currentVersionHeadingText = parsedHeading.versionText;
        }

        const badgeText = parsedHeading.versionText
            ? (parsedHeading.versionText.startsWith('v') ? parsedHeading.versionText : `v${parsedHeading.versionText}`)
            : '未知版本';
        const dateHtml = parsedHeading.dateText
            ? `<span class="changelog-version-date">${escapeMarkdownHtml(parsedHeading.dateText)}</span>`
            : '';
        const latestTagHtml = isLatest ? '<span class="changelog-version-latest">最新版本</span>' : '';
        const currentTagHtml = isCurrent ? '<span class="changelog-version-current">当前版本</span>' : '';
        const versionMetaHtml = (latestTagHtml || currentTagHtml)
            ? `<div class="changelog-version-meta">${latestTagHtml}${currentTagHtml}</div>`
            : '';
        const bodyHtml = renderChangelogSectionBody(section.bodyLines);
        const bodyWrapHtml = bodyHtml ? `<div class="changelog-version-body">${bodyHtml}</div>` : '';

        htmlParts.push(
            `<div class="changelog-version-row${isCurrent ? ' is-current' : ''}${isLatest ? ' is-latest' : ''}">
                <div class="changelog-version-head">
                    <div class="changelog-version-main">
                        <span class="changelog-version-badge">${escapeMarkdownHtml(badgeText)}</span>
                        ${dateHtml}
                    </div>
                    ${versionMetaHtml}
                </div>
                ${bodyWrapHtml}
            </div>`
        );
    }

    return {
        html: htmlParts.join(''),
        versionEntryCount,
        currentVersionPosition,
        currentVersionHeadingText,
        currentVersionDisplayText
    };
}

function formatVersionChangelogTime(timestamp) {
    if (!timestamp || !Number.isFinite(timestamp)) {
        return '';
    }
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

async function loadVersionChangelog(forceReload = false) {
    const contentEl = document.getElementById('versionChangelogContent');
    if (!contentEl) return;

    if (!forceReload && cachedChangelogRawText) {
        const renderResult = renderChangelogMarkdown(cachedChangelogRawText);
        contentEl.innerHTML = renderResult.html || '<p class="version-changelog-placeholder">暂无更新日志内容。</p>';
        const cachedAtText = formatVersionChangelogTime(cachedChangelogLoadedAt);
        if (cachedAtText) {
            console.log(`[请求RAW] 使用缓存更新日志，上次加载时间=${cachedAtText}`);
        } else {
            console.log('[请求RAW] 使用缓存更新日志');
        }
        if (renderResult.currentVersionPosition > 0) {
            console.log(
                `[更新日志] 当前版本定位成功: ${renderResult.currentVersionDisplayText || '当前版本'} 命中 ${renderResult.currentVersionHeadingText || ''}，位于第${renderResult.currentVersionPosition}条（共${renderResult.versionEntryCount}条）`
            );
        } else if (renderResult.versionEntryCount > 0) {
            console.log(
                `[更新日志] 当前版本未匹配到日志条目: ${renderResult.currentVersionDisplayText || '未知版本'}，日志共${renderResult.versionEntryCount}条`
            );
        }
        return;
    }

    if (pendingChangelogLoadPromise) {
        return pendingChangelogLoadPromise;
    }

    console.log('[请求RAW] 进度: 正在拉取更新日志');
    contentEl.innerHTML = '<p class="version-changelog-placeholder">正在加载更新日志...</p>';

    pendingChangelogLoadPromise = (async () => {
        try {
            const changelogText = await fetchWithAutoMirror(CHANGELOG_RAW_URL + '?_t=' + Date.now(), '更新日志');
            cachedChangelogRawText = changelogText;
            cachedChangelogLoadedAt = Date.now();

            const renderResult = renderChangelogMarkdown(changelogText);
            contentEl.innerHTML = renderResult.html || '<p class="version-changelog-placeholder">暂无更新日志内容。</p>';
            console.log(`[请求RAW] 成功: 更新日志已加载，时间=${formatVersionChangelogTime(cachedChangelogLoadedAt)}`);
            if (renderResult.currentVersionPosition > 0) {
                console.log(
                    `[更新日志] 当前版本定位成功: ${renderResult.currentVersionDisplayText || '当前版本'} 命中 ${renderResult.currentVersionHeadingText || ''}，位于第${renderResult.currentVersionPosition}条（共${renderResult.versionEntryCount}条）`
                );
            } else if (renderResult.versionEntryCount > 0) {
                console.log(
                    `[更新日志] 当前版本未匹配到日志条目: ${renderResult.currentVersionDisplayText || '未知版本'}，日志共${renderResult.versionEntryCount}条`
                );
            }
        } catch (error) {
            console.error('[请求RAW] 更新日志拉取失败:', error);
            contentEl.innerHTML = '<p class="version-changelog-placeholder">更新日志拉取失败，请稍后重试。</p>';
            showToast('更新日志加载失败: ' + error.message, 'error');
        } finally {
            pendingChangelogLoadPromise = null;
        }
    })();

    return pendingChangelogLoadPromise;
}

async function openVersionChangelogModal() {
    closeVersionInfoModal();
    const modal = document.getElementById('versionChangelogModal');
    if (!modal) return;

    modal.classList.add('show');
    await loadVersionChangelog(false);
}

function closeVersionChangelogModal(event) {
    if (event && event.target.id !== 'versionChangelogModal') return;
    const modal = document.getElementById('versionChangelogModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// 初始化增强型文本编辑器
function initLineEditor(textareaId) {
    const ta = document.getElementById(textareaId);
    if (!ta) return;
    const container = ta.closest('.line-editor');
    if (!container) return;
    const mirror = container.querySelector('.mirror');

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function render() {
        const value = ta.value || '';
        const lines = value.split(/\r\n|\r|\n/);

        mirror.style.width = ta.clientWidth + 'px';

        mirror.innerHTML = lines.map((l, i) => `<div class="logical-line" data-line-number="${i + 1}">${escapeHtml(l) || ' '}</div>`).join('');

        syncScroll();
    }

    function syncScroll() {
        mirror.scrollTop = ta.scrollTop;
    }

    let throttleTimeout;
    const debouncedRender = () => {
        cancelAnimationFrame(throttleTimeout);
        throttleTimeout = requestAnimationFrame(render);
    };

    // 监听输入、滚动
    ta.addEventListener('input', debouncedRender);
    ta.addEventListener('scroll', syncScroll);

    // 监听高度变化（ResizeObserver），解决拖拽角标后的同步问题
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => {
            // 当 textarea 高度或宽度变化时，重新渲染以确保宽度同步
            render();
        });
        ro.observe(ta);
    }

    // 窗口缩放时也刷新一下
    window.addEventListener('resize', debouncedRender);

    // 暴露渲染函数
    ta._refreshLineEditor = render;

    // 初始渲染
    render();
}

function refreshLineEditor(textarea) {
    if (!textarea) return;

    if (typeof textarea._refreshLineEditor === 'function') {
        textarea._refreshLineEditor();
        return;
    }

    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

async function loadConfig() {
    try {
        // 禁用 Rocket Loader 对该请求的影响
        const response = await fetch('/admin/config.json?_t=' + Date.now(), {
            method: 'GET',
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        });
        if (!response.ok) throw new Error('加载配置失败');
        currentConfig = await response.json();
        originalConfig = JSON.parse(JSON.stringify(currentConfig));
        renderUI();
        loadVersionByUUID(currentConfig.UUID);
        // 设置网页标题
        document.title = `${currentConfig.优选订阅生成?.SUBNAME || 'edgetunnel'} 设置页面 - 管理后台`;
    } catch (error) {
        updateVersionBadge('');
        showToast('加载配置失败: ' + error.message, 'error');
    }
}

function renderUI() {
    // 标题
    document.getElementById('pageTitle').textContent = (currentConfig.优选订阅生成?.SUBNAME || 'edgetunnel') + ' 设置页面';

    // 检查 CF 使用情况并显示模块
    const cfUsageModule = document.getElementById('cfUsageModule');
    const cfUsage = currentConfig.CF?.Usage;
    if (cfUsage && cfUsage.success) {
        cfUsageModule.style.display = 'block';
        cfUsageModule.classList.remove('cf-usage-module');
        updateCFUsageDisplay(cfUsage);
        updateCountdown(true);
        updateCloudflareButtonStates(true);
    } else {
        cfUsageModule.style.display = 'none';
        cfUsageModule.classList.add('cf-usage-module');
        updateCloudflareButtonStates(false);
    }

    // 检查 CF.UsageAPI 字段是否存在，向下兼容旧版本
    const usageapiOption = document.getElementById('usageapiOption');
    if (usageapiOption) {
        // 如果 CF.UsageAPI 字段不存在（旧版本），隐藏 UsageAPI 选项
        if (currentConfig.CF?.UsageAPI === undefined) {
            usageapiOption.style.display = 'none';
        } else {
            usageapiOption.style.display = '';
        }
    }

    // 订阅链接
    const token = currentConfig.优选订阅生成?.TOKEN;
    const host = window.location.host;
    const link = currentConfig.LINK;
    document.getElementById('LinkURL').value = currentConfig.LINK;
    document.getElementById('subLink').value = `https://${host}/sub?token=${token}`;
    document.getElementById('base64Link').value = `https://${host}/sub?token=${token}&b64`;
    document.getElementById('clashLink').value = `https://${host}/sub?token=${token}&clash`;
    document.getElementById('singboxLink').value = `https://${host}/sub?token=${token}&sb`;

    // 编辑订阅生成
    const local = currentConfig.优选订阅生成?.local ?? true;
    const randomIP = currentConfig.优选订阅生成?.本地IP库?.随机IP ?? true;

    if (!local) {
        document.getElementById('ipMode').value = 'generator';
        document.getElementById('generatorURL').value = currentConfig.优选订阅生成?.SUB || '';
    } else if (randomIP) {
        document.getElementById('ipMode').value = 'random';
        document.getElementById('randomCount').value = currentConfig.优选订阅生成?.本地IP库?.随机数量 || 16;
        // 设置指定端口
        if (currentConfig.优选订阅生成?.本地IP库?.指定端口 !== undefined) {
            document.getElementById('specifiedPort').value = currentConfig.优选订阅生成.本地IP库.指定端口;
        }
    } else {
        document.getElementById('ipMode').value = 'custom';
        loadCustomIPs();
    }
    updateIPMode();

    // 详细配置
    document.getElementById('subName').value = currentConfig.优选订阅生成?.SUBNAME || '';

    // 检查 HOSTS 数组是否存在
    hasMultipleHosts = Array.isArray(currentConfig.HOSTS) && currentConfig.HOSTS.length > 0;

    const nodeHostInput = document.getElementById('nodeHost');
    if (hasMultipleHosts) {
        // 如果存在 HOSTS 数组，用逗号连接显示所有 host
        nodeHostInput.value = currentConfig.HOSTS.join('、');
        // 添加可点击样式和事件
        nodeHostInput.classList.add('nodeHost-clickable');
        nodeHostInput.title = '点击 可编辑多个节点域名';
        nodeHostInput.onclick = openHostsEditModal;
    } else {
        // 否则显示单个 HOST
        nodeHostInput.value = currentConfig.HOST || '';
        // 移除可点击样式和事件
        nodeHostInput.classList.remove('nodeHost-clickable');
        nodeHostInput.title = '节点域名';
        nodeHostInput.onclick = null;
    }

    document.getElementById('nodeUUID').value = currentConfig.UUID || '';
    document.getElementById('nodePATH').value = currentConfig.PATH || '';
    syncSSProtocolSettingsFromConfig();
    document.getElementById('protocol').value = currentConfig.协议类型 || 'vless';
    syncTransportSettingsFromConfig();
    updateProtocol();

    // 检查跳过证书验证字段是否存在
    const skipVerifyGroup = document.getElementById('skipVerifyGroup');
    if (currentConfig['跳过证书验证'] !== undefined) {
        skipVerifyGroup.style.setProperty('display', 'flex', 'important');
        document.getElementById('skipVerify').checked = currentConfig['跳过证书验证'] || false;
    } else {
        skipVerifyGroup.style.setProperty('display', 'none', 'important');
    }

    // 检查"完整节点路径"字段是否存在，判断PATH是否可编辑
    const nodePathInput = document.getElementById('nodePATH');
    if (currentConfig['完整节点路径'] !== undefined) {
        // 存在该字段，表示后端支持编辑PATH，移除readonly属性
        nodePathInput.removeAttribute('readonly');
        nodePathInput.title = '节点的伪装路径';
        nodePathInput.onchange = handlePathChange;
    } else {
        // 不存在该字段，PATH保持只读状态
        nodePathInput.setAttribute('readonly', '');
        nodePathInput.title = '节点的伪装路径 仅可通过 \'PATH\'环境变量 进行修改';
        nodePathInput.onchange = null;
    }

    // 检查Fingerprint字段是否存在
    const fingerprintGroup = document.getElementById('fingerprintGroup');
    const fingerprintSelect = document.getElementById('fingerprint');
    if (currentConfig['Fingerprint'] == undefined) {
        fingerprintGroup.style.setProperty('display', 'none', 'important');
    } else {
        fingerprintSelect.value = currentConfig['Fingerprint'] || 'chrome';
    }

    // 检查随机路径字段是否存在
    const randomPathGroup = document.getElementById('randomPathGroup');
    const randomPathCheckbox = document.getElementById('randomPath');
    if (currentConfig['随机路径'] !== undefined) {
        randomPathGroup.style.setProperty('display', 'flex', 'important');
        randomPathCheckbox.checked = currentConfig['随机路径'] || false;
    } else {
        randomPathGroup.style.setProperty('display', 'none', 'important');
    }

    // 检查启用0RTT字段是否存在
    const enable0RTTGroup = document.getElementById('enable0RTTGroup');
    const enable0RTTCheckbox = document.getElementById('enable0RTT');
    if (currentConfig['启用0RTT'] !== undefined) {
        enable0RTTGroup.style.setProperty('display', 'flex', 'important');
        enable0RTTCheckbox.checked = currentConfig['启用0RTT'] || false;
    } else {
        enable0RTTGroup.style.setProperty('display', 'none', 'important');
    }

    // 检查TLS分片字段是否存在
    const tlsFragmentGroup = document.getElementById('tlsFragmentGroup');
    const tlsFragmentHappGroup = document.getElementById('tlsFragmentHappGroup');
    const tlsFragmentShadowrocket = document.getElementById('tlsFragmentShadowrocket');
    const tlsFragmentHapp = document.getElementById('tlsFragmentHapp');
    if (currentConfig['TLS分片'] !== undefined) {
        tlsFragmentGroup.style.setProperty('display', 'flex', 'important');
        tlsFragmentHappGroup.style.setProperty('display', 'flex', 'important');
        // 根据当前值设置勾选状态
        tlsFragmentShadowrocket.checked = currentConfig['TLS分片'] === 'Shadowrocket';
        tlsFragmentHapp.checked = currentConfig['TLS分片'] === 'Happ';
    } else {
        tlsFragmentGroup.style.setProperty('display', 'none', 'important');
        tlsFragmentHappGroup.style.setProperty('display', 'none', 'important');
    }

    // 检查ECH字段是否存在
    const echModule = document.getElementById('echModule');
    const enableECHCheckbox = document.getElementById('enableECH');
    if (currentConfig['ECH'] !== undefined) {
        echModule.style.display = 'block';
        enableECHCheckbox.checked = currentConfig['ECH'] || false;
        // 根据Fingerprint值初始化ECH选项的禁用状态
        updateECHOptionState();

        // 填充ECH DNS下拉框
        populateEchDNSSelect();

        // 填充ECH SNI下拉框
        populateEchSNISelect();
    } else {
        echModule.style.display = 'none';
    }

    // 反代落地设置
    const socksEnabled = currentConfig.反代?.SOCKS5?.启用;
    if (!socksEnabled) {
        document.getElementById('proxyMode').value = 'auto';
        document.getElementById('proxyIP').value = currentConfig.反代?.PROXYIP || '';
        document.getElementById('autoProxy').checked = (currentConfig.反代?.PROXYIP === 'auto');
        if (currentConfig.反代?.PROXYIP === 'auto') {
            document.getElementById('proxyIP').disabled = true;
        }
    } else if (socksEnabled === 'socks5') {
        document.getElementById('proxyMode').value = 'socks5';
        document.getElementById('socks5Addr').value = currentConfig.反代?.SOCKS5?.账号 || '';
        document.getElementById('globalSocks5').checked = currentConfig.反代?.SOCKS5?.全局 || false;
    } else if (socksEnabled === 'http') {
        document.getElementById('proxyMode').value = 'http';
        document.getElementById('httpAddr').value = currentConfig.反代?.SOCKS5?.账号 || '';
        document.getElementById('globalHTTP').checked = currentConfig.反代?.SOCKS5?.全局 || false;
    } else if (socksEnabled === 'https') {
        document.getElementById('proxyMode').value = 'https';
        document.getElementById('httpsAddr').value = currentConfig.反代?.SOCKS5?.账号 || '';
        document.getElementById('globalHTTPS').checked = currentConfig.反代?.SOCKS5?.全局 || false;
    }
    updateProxyMode();

    // 检查路径模板字段是否存在
    const pathTemplateConfigBtn = document.getElementById('pathTemplateConfigBtn');
    if (currentConfig.反代?.路径模板 !== undefined) {
        pathTemplateConfigBtn.style.display = '';
    } else {
        pathTemplateConfigBtn.style.display = 'none';
    }

    // 订阅转换配置
    document.getElementById('subAPI').value = currentConfig.订阅转换配置?.SUBAPI || '';
    document.getElementById('subConfig').value = currentConfig.订阅转换配置?.SUBCONFIG || '';
    document.getElementById('emoji').checked = currentConfig.订阅转换配置?.SUBEMOJI || false;

    // 消息通知设置 - 兼容两种config结构
    // 优先读取 TG 字段，如果没有则读取 通知.Telegram
    const telegramBotToken = currentConfig.TG?.BotToken || currentConfig.通知?.Telegram?.BotToken;
    const telegramChatID = currentConfig.TG?.ChatID || currentConfig.通知?.Telegram?.ChatID;
    const telegramCheckbox = document.getElementById('telegramEnabled');

    // 判断TG配置是否完整（BotToken和ChatID都非null且非空字符串）
    if (telegramBotToken && telegramChatID) {
        // 两个都有，启用checkbox，并加载 TG.启用 的状态
        telegramCheckbox.disabled = false;
        telegramCheckbox.checked = currentConfig.TG?.启用 ?? false;
        // "参数配置"按钮颜色为绿色，表示已配置
        updateTelegramButtonStates(true);
        // "清除配置"按钮为红色，且可点击
    } else {
        // 任意一个缺少，禁用checkbox
        telegramCheckbox.disabled = true;
        telegramCheckbox.checked = false;
        // "参数配置"按钮颜色为默认色，表示未配置
        updateTelegramButtonStates(false);
        // "清除配置"按钮为灰色，且不可点击
    }

    modifiedSections.clear();
    resetAllButtons();

    // 从 localStorage 加载模块展开/折叠状态
    loadModuleStates();

    // 填充 SubConfig 下拉框（如果数据已加载，会自动设置选中值）
    populateSubConfigSelect();

    // 检查当前域名是否在 HOSTS 数组中
    checkHostsMismatch();
}

// CF 使用情况显示函数
function updateCFUsageDisplay(cfUsage) {
    const workers = cfUsage.workers || 0;
    const pages = cfUsage.pages || 0;
    const total = cfUsage.total || 0;
    const dailyQuota = cfUsage.max || 100000;

    // 更新显示数值
    document.getElementById('cfWorkerCount').textContent = workers.toLocaleString();
    document.getElementById('cfPagesCount').textContent = pages.toLocaleString();
    document.getElementById('cfDailyQuota').textContent = dailyQuota.toLocaleString();
    document.getElementById('cfTotalDisplay').textContent = total.toLocaleString();

    // 计算百分比
    const percentage = ((total / dailyQuota) * 100).toFixed(2);

    // 计算比例并设置进度条宽度
    const workersRatio = (workers / dailyQuota) * 100;
    const pagesRatio = (pages / dailyQuota) * 100;

    // Workers 进度条：从左边开始
    const workerBarEl = document.getElementById('cfWorkerBar');
    workerBarEl.style.width = Math.min(workersRatio, 100) + '%';
    workerBarEl.textContent = '';

    // Pages 进度条：紧跟在 Workers 进度条后面
    const pagesBarEl = document.getElementById('cfPagesBar');
    pagesBarEl.style.width = Math.min(pagesRatio, 100 - workersRatio) + '%';
    pagesBarEl.style.left = Math.min(workersRatio, 100) + '%';
    pagesBarEl.textContent = '';

    // 总体百分比文字 (中央)
    const percentageCenterEl = document.getElementById('cfPercentageCenter');
    percentageCenterEl.textContent = `请求使用进度: ${total.toLocaleString()} (${percentage}%)`;
}

async function loadCustomIPs() {
    const textarea = document.getElementById('customIPs');
    textarea.disabled = true;
    textarea.value = '正在加载...';
    if (textarea._refreshLineEditor) textarea._refreshLineEditor();

    try {
        const response = await fetch('/admin/ADD.txt?_t=' + Date.now(), {
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        });
        if (response.ok) {
            textarea.value = await response.text();
        } else {
            textarea.value = '';
        }
    } catch (error) {
        showToast('加载自定义IP失败', 'error');
        textarea.value = '';
    } finally {
        textarea.disabled = false;
        if (textarea._refreshLineEditor) textarea._refreshLineEditor();
    }
}

function updateIPMode() {
    const mode = document.getElementById('ipMode').value;

    const sections = {
        'random': document.getElementById('randomIPSection'),
        'custom': document.getElementById('customIPSection'),
        'generator': document.getElementById('generatorSection')
    };

    Object.keys(sections).forEach(key => {
        const el = sections[key];
        if (el) {
            if (key === mode) {
                el.classList.remove('hidden-section');
                el.style.display = (key === 'custom') ? 'block' : 'grid';
            } else {
                el.classList.add('hidden-section');
                el.style.display = 'none';
            }
        }
    });

    // 显示或隐藏指定端口
    const portSection = document.getElementById('portSection');
    if (portSection) {
        if (mode === 'random' && currentConfig.优选订阅生成?.本地IP库?.指定端口 !== undefined) {
            portSection.classList.remove('hidden-section');
            portSection.style.display = 'grid';
        } else {
            portSection.classList.add('hidden-section');
            portSection.style.display = 'none';
        }
    }

    // 显示或隐藏在线优选和订阅接口按钮（仅在自定义优选模式下显示）
    const onlineOptimizeBtn = document.getElementById('onlineOptimizeBtn');
    const apiOptimizeBtn = document.getElementById('apiOptimizeBtn');
    if (onlineOptimizeBtn) {
        if (mode === 'custom') {
            onlineOptimizeBtn.classList.remove('hidden-section');
        } else {
            onlineOptimizeBtn.classList.add('hidden-section');
        }
    }
    if (apiOptimizeBtn) {
        if (mode === 'custom') {
            apiOptimizeBtn.classList.remove('hidden-section');
        } else {
            apiOptimizeBtn.classList.add('hidden-section');
        }
    }

    // 当切换到自定义优选时，自动加载现有的ADD.txt内容
    if (mode === 'custom') {
        loadCustomIPs();
    }

    markModified('sub');
}

// 处理优选订阅生成器URL
function processGeneratorURL() {
    const input = document.getElementById('generatorURL').value.trim();
    let domain = '';

    if (input) {
        // 如果输入不是空的，提取域名
        domain = extractDomain(input);
        document.getElementById('generatorURL').value = domain;
    }

    markModified('sub');
}

// 提取URL中的纯域名
function extractDomain(url) {
    try {
        url = url.trim();

        // 如果不包含协议，尝试识别是否为完整URL或纯域名
        if (!url.includes('://')) {
            // 检查是否包含路径、查询参数或端口
            if (url.includes('/') || url.includes('?') || url.includes(':')) {
                // 这是一个完整的URL，补充https协议
                url = 'https://' + url;
            } else {
                // 这是纯域名，直接返回
                return url;
            }
        }

        // 解析URL
        const urlObj = new URL(url);

        // 获取hostname（不包含端口）
        let domain = urlObj.hostname;

        // 移除www前缀（如果有）
        if (domain.startsWith('www.')) {
            domain = domain.substring(4);
        }

        return domain;
    } catch (error) {
        // 如果URL解析失败，返回原始输入去掉协议部分的结果
        let temp = url.trim();
        if (temp.includes('://')) {
            temp = temp.split('://')[1];
        }
        if (temp.includes('/')) {
            temp = temp.split('/')[0];
        }
        if (temp.includes('?')) {
            temp = temp.split('?')[0];
        }
        if (temp.includes(':')) {
            temp = temp.split(':')[0];
        }
        if (temp.startsWith('www.')) {
            temp = temp.substring(4);
        }
        return temp;
    }
}

function updateGrpcModeVisibility() {
    const transportSelect = document.getElementById('transport');
    const grpcModeGroup = document.getElementById('grpcModeGroup');
    const grpcUserAgentGroup = document.getElementById('grpcUserAgentGroup');
    if (!transportSelect || !grpcModeGroup) return;

    const isGrpcTransport = transportSelect.value === 'grpc';
    const hasGrpcModeField = currentConfig && currentConfig['gRPC模式'] !== undefined;
    const hasGrpcUserAgentField = currentConfig && currentConfig['gRPCUserAgent'] !== undefined;

    grpcModeGroup.style.display = hasGrpcModeField && isGrpcTransport ? '' : 'none';
    if (grpcUserAgentGroup) {
        grpcUserAgentGroup.style.display = hasGrpcUserAgentField && isGrpcTransport ? '' : 'none';
    }
}

function showTransportGrpcTooltip() {
    const modal = document.getElementById('transportGrpcModal');
    if (!modal) return;
    modal.classList.add('show');
}

function hideTransportGrpcTooltip() {
    const modal = document.getElementById('transportGrpcModal');
    if (!modal) return;
    modal.classList.remove('show');
}

function closeTransportGrpcModal(event) {
    if (event && event.target && event.target.id !== 'transportGrpcModal') {
        return;
    }
    hideTransportGrpcTooltip();
}

function showSSTLSDisableModal(previousValue) {
    const modal = document.getElementById('ssTLSDisableModal');
    if (!modal) return;
    pendingSSTLSPreviousValue = previousValue;
    modal.classList.add('show');
}

function hideSSTLSDisableModal() {
    const modal = document.getElementById('ssTLSDisableModal');
    if (!modal) return;
    modal.classList.remove('show');
}

function closeSSTLSDisableModal(event) {
    if (event && event.target && event.target.id !== 'ssTLSDisableModal') {
        return;
    }
    cancelDisableSSTLS();
}

function confirmDisableSSTLS() {
    const ssTLSSelect = document.getElementById('ssTLS');
    if (!ssTLSSelect) return;

    ssTLSSelect.value = 'false';
    ssTLSSelect.dataset.confirmedValue = 'false';
    pendingSSTLSPreviousValue = null;
    hideSSTLSDisableModal();
    updateProtocol();
    markModified('config');
}

function cancelDisableSSTLS() {
    const ssTLSSelect = document.getElementById('ssTLS');
    if (ssTLSSelect) {
        const restoredValue = pendingSSTLSPreviousValue || ssTLSSelect.dataset.confirmedValue || 'true';
        ssTLSSelect.value = restoredValue;
        ssTLSSelect.dataset.confirmedValue = restoredValue;
    }
    pendingSSTLSPreviousValue = null;
    hideSSTLSDisableModal();
    updateProtocol();
}

function handleSSTLSChange(event) {
    const ssTLSSelect = document.getElementById('ssTLS');
    if (!ssTLSSelect) return;

    const nextValue = ssTLSSelect.value;
    const previousValue = ssTLSSelect.dataset.confirmedValue || 'true';
    const shouldConfirmDisable = nextValue === 'false' && previousValue !== 'false' && (!event || event.isTrusted);

    if (shouldConfirmDisable) {
        showSSTLSDisableModal(previousValue);
        return;
    }

    ssTLSSelect.dataset.confirmedValue = nextValue;
    updateProtocol();
    markModified('config');
}

function updateTransportGrpcTooltipVisibility(showWhenSupportedTransport = false) {
    const transportSelect = document.getElementById('transport');
    if (!transportSelect) return;

    const needsGrpcNotice = transportSelect.value === 'xhttp' || transportSelect.value === 'grpc';
    if (needsGrpcNotice && showWhenSupportedTransport) {
        showTransportGrpcTooltip();
        return;
    }

    hideTransportGrpcTooltip();
}

function handleTransportChange() {
    updateGrpcModeVisibility();
    updateTransportGrpcTooltipVisibility(true);
    const protocolSelect = document.getElementById('protocol');
    updateProtocolOptionAvailability(protocolSelect ? protocolSelect.value : '');
    markModified('config');
}

function fillCurrentGrpcUA() {
    const grpcUserAgentInput = document.getElementById('grpcUserAgent');
    if (!grpcUserAgentInput) return;

    grpcUserAgentInput.value = navigator.userAgent || '';
    markModified('config');
}

function syncTransportSettingsFromConfig() {
    const transportGroup = document.getElementById('transportGroup');
    const transportSelect = document.getElementById('transport');
    const grpcModeGroup = document.getElementById('grpcModeGroup');
    const grpcModeSelect = document.getElementById('grpcMode');
    const grpcUserAgentGroup = document.getElementById('grpcUserAgentGroup');
    const grpcUserAgentInput = document.getElementById('grpcUserAgent');
    if (!transportGroup || !transportSelect || !grpcModeGroup || !grpcModeSelect) return;

    const hasGrpcModeField = currentConfig && currentConfig['gRPC模式'] !== undefined;
    const hasGrpcUserAgentField = currentConfig && currentConfig['gRPCUserAgent'] !== undefined;
    if (!hasGrpcModeField) {
        transportGroup.style.display = 'none';
        grpcModeGroup.style.display = 'none';
        if (grpcUserAgentGroup) {
            grpcUserAgentGroup.style.display = 'none';
        }
        hideTransportGrpcTooltip();
        return;
    }

    transportGroup.style.display = '';

    transportSelect.value = currentConfig['传输协议'] || 'ws';
    if (!transportSelect.value) {
        transportSelect.value = 'ws';
    }

    grpcModeSelect.value = currentConfig['gRPC模式'] || 'gun';
    if (!grpcModeSelect.value) {
        grpcModeSelect.value = 'gun';
    }

    if (grpcUserAgentInput) {
        grpcUserAgentInput.value = hasGrpcUserAgentField ? (currentConfig['gRPCUserAgent'] || '') : '';
    }

    updateGrpcModeVisibility();
    updateTransportGrpcTooltipVisibility(false);
}

function syncSSProtocolSettingsFromConfig() {
    const protocolSelect = document.getElementById('protocol');
    const ssMethodSelect = document.getElementById('ssMethod');
    const ssTLSSelect = document.getElementById('ssTLS');
    if (!protocolSelect || !ssMethodSelect || !ssTLSSelect) return;

    const hasSSConfig = !!(currentConfig && currentConfig.SS && typeof currentConfig.SS === 'object');
    const ssOption = protocolSelect.querySelector('option[value="ss"]');
    const ssMethodKey = '\u52a0\u5bc6\u65b9\u5f0f';

    if (hasSSConfig) {
        if (!ssOption) {
            const option = document.createElement('option');
            option.value = 'ss';
            option.textContent = 'Shadowsocks';
            protocolSelect.appendChild(option);
        }

        const savedMethod = currentConfig.SS[ssMethodKey];
        ssMethodSelect.value = savedMethod || 'aes-128-gcm';
        if (!ssMethodSelect.value) {
            ssMethodSelect.value = 'aes-128-gcm';
        }

        ssTLSSelect.value = currentConfig.SS.TLS ? 'true' : 'false';
        ssTLSSelect.dataset.confirmedValue = ssTLSSelect.value;
        return;
    }

    if (ssOption) {
        ssOption.remove();
    }
    if (protocolSelect.value === 'ss') {
        protocolSelect.value = 'vless';
    }

    ssMethodSelect.value = 'aes-128-gcm';
    ssTLSSelect.value = 'false';
    ssTLSSelect.dataset.confirmedValue = ssTLSSelect.value;
}

function updateSpecifiedPortLabelsByProtocol(protocol) {
    const specifiedPortSelect = document.getElementById('specifiedPort');
    if (!specifiedPortSelect) return;
    const ssTLSSelect = document.getElementById('ssTLS');

    const defaultLabels = {
        '-1': '随机端口',
        '443': '443',
        '2053': '2053',
        '2083': '2083',
        '2087': '2087',
        '2096': '2096',
        '8443': '8443'
    };

    const shadowsocksLabels = {
        '-1': '随机端口',
        '443': '80',
        '2053': '2052',
        '2083': '2082',
        '2087': '2086',
        '2096': '2095',
        '8443': '8080'
    };

    const useShadowsocksNoTLSLabels = protocol === 'ss' && ssTLSSelect && ssTLSSelect.value === 'false';
    const labelMap = useShadowsocksNoTLSLabels ? shadowsocksLabels : defaultLabels;
    Array.from(specifiedPortSelect.options).forEach((option) => {
        const nextLabel = labelMap[option.value];
        if (nextLabel !== undefined) {
            option.textContent = nextLabel;
        }
    });
}

function updateProtocolOptionAvailability(protocol) {
    const ssTLSSelect = document.getElementById('ssTLS');
    const transportSelect = document.getElementById('transport');
    const enable0RTT = document.getElementById('enable0RTT');
    const skipVerify = document.getElementById('skipVerify');
    const tlsFragmentShadowrocket = document.getElementById('tlsFragmentShadowrocket');
    const tlsFragmentHapp = document.getElementById('tlsFragmentHapp');

    const isShadowsocks = protocol === 'ss';
    const isShadowsocksNoTLS = isShadowsocks && ssTLSSelect && ssTLSSelect.value === 'false';
    const isGrpcTransport = !!(transportSelect && transportSelect.value === 'grpc');
    const shouldDisable0RTT = isShadowsocks || isGrpcTransport;

    if (enable0RTT) {
        enable0RTT.disabled = shouldDisable0RTT;
        if (shouldDisable0RTT && enable0RTT.checked) {
            enable0RTT.checked = false;
        }
    }

    [skipVerify, tlsFragmentShadowrocket, tlsFragmentHapp].forEach((checkbox) => {
        if (checkbox) {
            checkbox.disabled = isShadowsocksNoTLS;
            if (isShadowsocksNoTLS && checkbox.checked) {
                checkbox.checked = false;
            }
        }
    });
}

function updateProtocol() {
    const protocolSelect = document.getElementById('protocol');
    const ssMethodGroup = document.getElementById('ssMethodGroup');
    const ssTLSGroup = document.getElementById('ssTLSGroup');
    if (!protocolSelect || !ssMethodGroup || !ssTLSGroup) return;

    const hasSSConfig = !!(currentConfig && currentConfig.SS && typeof currentConfig.SS === 'object');
    const showSSFields = hasSSConfig && protocolSelect.value === 'ss';
    ssMethodGroup.style.display = showSSFields ? '' : 'none';
    ssTLSGroup.style.display = showSSFields ? '' : 'none';

    const protocol = protocolSelect.value;
    updateSpecifiedPortLabelsByProtocol(protocol);
    updateProtocolOptionAvailability(protocol);
    const transport = document.getElementById('transport');
    if (transport) {
        const shouldLockTransport = protocol === 'ss';
        if (shouldLockTransport) {
            transport.value = 'ws';
        }
        transport.disabled = shouldLockTransport;
        updateGrpcModeVisibility();
        updateTransportGrpcTooltipVisibility(false);
    }

    // 协议/TLS 变化会影响 ECH 可用性
    updateECHOptionState();
}

// 处理浏览器指纹变化，联动ECH选项
function handleFingerprintChange() {
    updateECHOptionState();
}

// 处理ECH启用状态变化
function handleECHEnableChange() {
    const enableECHCheckbox = document.getElementById('enableECH');
    const fingerprintSelect = document.getElementById('fingerprint');

    // 支持ECH的指纹类型
    const supportECH = ['chrome', 'firefox'];

    // 如果用户开启ECH，但当前指纹不支持ECH，自动切换到chrome
    if (enableECHCheckbox && enableECHCheckbox.checked) {
        const currentFingerprint = fingerprintSelect?.value;
        if (currentFingerprint && !supportECH.includes(currentFingerprint)) {
            fingerprintSelect.value = 'chrome';
            // 同时标记详细配置模块为已修改
            markModified('config');
        }
    }

    markModified('ech');
}

// 更新ECH选项的状态（禁用/启用）
function updateECHOptionState() {
    const fingerprint = document.getElementById('fingerprint')?.value;
    const enableECHCheckbox = document.getElementById('enableECH');
    const protocol = document.getElementById('protocol')?.value;
    const ssTLS = document.getElementById('ssTLS')?.value;

    // 支持ECH的指纹类型
    const supportECH = ['chrome', 'firefox'];
    const isFingerprintSupported = supportECH.includes(fingerprint);
    const isSSWithoutTLS = protocol === 'ss' && ssTLS === 'false';
    const shouldDisableECH = !isFingerprintSupported || isSSWithoutTLS;

    if (enableECHCheckbox) {
        // 当不满足条件时，自动取消勾选
        if (shouldDisableECH && enableECHCheckbox.checked) {
            enableECHCheckbox.checked = false;
            markModified('ech');
        }

        // SS + TLS关闭 或 指纹不支持时，ECH启用不可编辑
        enableECHCheckbox.disabled = shouldDisableECH;
    }
}

// 填充ECH DNS下拉框
function populateEchDNSSelect() {
    const formGroup = document.getElementById('echDNSGroup');
    const select = document.getElementById('echDNSSelect');
    const customInput = document.getElementById('echDNSCustomInput');
    const hiddenValue = document.getElementById('echDNSValue');

    if (!select || !formGroup) return;

    // 检查ECHConfig.DNS字段是否存在
    if (currentConfig.ECHConfig?.DNS === undefined) {
        formGroup.style.display = 'none';
        return;
    }

    // 显示form-group和下拉框
    formGroup.style.display = 'grid';
    select.style.display = 'block';

    // 如果已有保存的DNS值，设置选中状态
    const savedDNS = currentConfig.ECHConfig?.DNS || '';
    if (savedDNS) {
        // 尝试在下拉框中找到匹配的选项
        select.value = savedDNS;

        // 如果没有匹配到（值不在列表中），选择"自定义"并显示输入框
        if (select.value !== savedDNS) {
            select.value = 'custom';
            customInput.value = savedDNS;
            customInput.style.display = 'block';
            hiddenValue.value = savedDNS;
        } else {
            // 匹配成功，隐藏自定义输入框
            customInput.style.display = 'none';
            customInput.value = '';
            hiddenValue.value = savedDNS;
        }
    } else {
        // 没有保存值，默认选择"自定义"
        select.value = 'custom';
        customInput.style.display = 'block';
    }
}

// 填充ECH SNI下拉框
function populateEchSNISelect() {
    const formGroup = document.getElementById('echSNIGroup');
    const select = document.getElementById('echSNISelect');
    const customInput = document.getElementById('echSNICustomInput');
    const hiddenValue = document.getElementById('echSNIValue');

    if (!select || !formGroup) return;

    // 检查ECHConfig.SNI字段是否存在
    if (currentConfig.ECHConfig?.SNI === undefined) {
        formGroup.style.display = 'none';
        return;
    }

    // 显示form-group和下拉框
    formGroup.style.display = 'grid';
    select.style.display = 'block';

    // 如果已有保存的SNI值，设置选中状态
    const savedSNI = currentConfig.ECHConfig?.SNI;
    if (savedSNI !== undefined) {
        if (savedSNI === null) {
            // 自动获取
            select.value = '__AUTO__';
            customInput.style.display = 'none';
            customInput.value = '';
            hiddenValue.value = null;
        } else {
            // 尝试在下拉框中找到匹配的选项
            select.value = savedSNI;

            // 如果没有匹配到（值不在列表中），选择"自定义"并显示输入框
            if (select.value !== savedSNI) {
                select.value = 'custom';
                customInput.value = savedSNI;
                customInput.style.display = 'block';
                hiddenValue.value = savedSNI;
            } else {
                // 匹配成功，隐藏自定义输入框
                customInput.style.display = 'none';
                customInput.value = '';
                hiddenValue.value = savedSNI;
            }
        }
    } else {
        // 没有保存值，默认选择"自定义"
        select.value = 'custom';
        customInput.style.display = 'block';
    }
}

// ECH DNS select 变化处理
function onEchDNSSelectChange() {
    const select = document.getElementById('echDNSSelect');
    const customInput = document.getElementById('echDNSCustomInput');
    const hiddenValue = document.getElementById('echDNSValue');

    if (select.value === 'custom') {
        customInput.style.display = 'block';
        hiddenValue.value = customInput.value;
    } else {
        customInput.style.display = 'none';
        customInput.value = '';
        hiddenValue.value = select.value;
    }

    // 检查是否选择了国内DNS，若是则自动调整ECH解析域名
    const selectedOption = select.options[select.selectedIndex];
    const region = selectedOption.dataset.region;

    if (region === 'domestic') {
        const echSNISelect = document.getElementById('echSNISelect');
        // 如果当前选择是 __AUTO__，自动改为 cloudflare-ech.com
        if (echSNISelect.value === '__AUTO__') {
            echSNISelect.value = 'cloudflare-ech.com';
            onEchSNISelectChange();
        }
    }

    markModified('ech');
}

// ECH DNS 自定义输入框变化处理
function onEchDNSCustomInput() {
    const customInput = document.getElementById('echDNSCustomInput');
    const hiddenValue = document.getElementById('echDNSValue');
    hiddenValue.value = customInput.value;
    markModified('ech');
}

// ECH SNI select 变化处理
function onEchSNISelectChange() {
    const select = document.getElementById('echSNISelect');
    const customInput = document.getElementById('echSNICustomInput');
    const hiddenValue = document.getElementById('echSNIValue');

    if (select.value === '__AUTO__') {
        customInput.style.display = 'none';
        customInput.value = '';
        hiddenValue.value = null;

        // 检查当前DNS服务是否为国内DNS
        const echDNSSelect = document.getElementById('echDNSSelect');
        const selectedDNSOption = echDNSSelect.options[echDNSSelect.selectedIndex];
        const dnsRegion = selectedDNSOption.dataset.region;

        if (dnsRegion === 'domestic') {
            alert('⚠️ ECH 配置提示\n\n默认使用节点HOST伪装域名 配合 国内 DNS 可能导致 ECH 解析失败。\n\n解决方案（任选其一）：\n① 将 ECH 解析域名改为 cloudflare-ech.com（推荐）\n② 将 ECH DNS 切换为国际服务（如 NextDNS）');
            select.value = 'cloudflare-ech.com';
        }
    } else if (select.value === 'custom') {
        customInput.style.display = 'block';
        hiddenValue.value = customInput.value;
    } else {
        customInput.style.display = 'none';
        customInput.value = '';
        hiddenValue.value = select.value;
    }
    markModified('ech');
}

// ECH SNI 自定义输入框变化处理
function onEchSNICustomInput() {
    const customInput = document.getElementById('echSNICustomInput');
    const hiddenValue = document.getElementById('echSNIValue');
    hiddenValue.value = customInput.value;
    markModified('ech');
}

// 处理PROXYIP地址
function processProxyIP() {
    const input = document.getElementById('proxyIP').value.trim();

    if (input && input !== 'auto') {
        const cleanAddress = extractProxyIPAddress(input);
        document.getElementById('proxyIP').value = cleanAddress;
    }

    markModified('proxy');
}

// 提取PROXYIP地址中的纯格式（保留端口号）
function extractProxyIPAddress(input) {
    input = input.trim();

    // 首先检查是否包含 "ip=" (包括 proxyip= 和 pyip=)
    const ipPatterns = ['proxyip=', 'pyip=', 'ip='];
    for (const pattern of ipPatterns) {
        const index = input.toLowerCase().indexOf(pattern);
        if (index !== -1) {
            input = input.substring(index + pattern.length).trim();
            break;
        }
    }

    // 移除协议前缀 (http:// 或 https://)
    if (input.toLowerCase().startsWith('http://')) {
        input = input.substring(7).trim();
    } else if (input.toLowerCase().startsWith('https://')) {
        input = input.substring(8).trim();
    }

    // 移除末尾的斜杠
    if (input.endsWith('/')) {
        input = input.substring(0, input.length - 1).trim();
    }

    // 移除末尾的备注（#符号之后的内容）
    if (input.includes('#')) {
        input = input.split('#')[0].trim();
    }

    return input;
}

// 处理SOCKS5、HTTP和HTTPS代理地址
function processProxyAddress(type) {
    const fieldId = type === 'socks5' ? 'socks5Addr' : (type === 'https' ? 'httpsAddr' : 'httpAddr');
    const input = document.getElementById(fieldId).value.trim();
    let cleanAddress = '';

    if (input) {
        cleanAddress = extractProxyAddress(input, type);
        document.getElementById(fieldId).value = cleanAddress;

        // 如果输入内容包含协议标识，自动切换反代模式并转移内容
        switchProxyModeByProtocol(input, cleanAddress);
    }

    markModified('proxy');
}

// 提取代理地址中的纯格式
function extractProxyAddress(input, type) {
    input = input.trim();

    // 移除开头的 "/" 或 "/"
    if (input.startsWith('/')) {
        input = input.substring(1).trim();
    }

    // 检测并移除协议前缀
    const socks5Prefixes = ['socks5://', 'socks5=', 'socks5://'];
    const httpPrefixes = ['http://', 'http='];
    const httpsPrefixes = ['https://', 'https='];

    for (const prefix of socks5Prefixes) {
        if (input.toLowerCase().startsWith(prefix)) {
            input = input.substring(prefix.length).trim();
            break;
        }
    }

    for (const prefix of httpPrefixes) {
        if (input.toLowerCase().startsWith(prefix)) {
            input = input.substring(prefix.length).trim();
            break;
        }
    }

    for (const prefix of httpsPrefixes) {
        if (input.toLowerCase().startsWith(prefix)) {
            input = input.substring(prefix.length).trim();
            break;
        }
    }

    // 移除末尾的备注（#符号之后的内容）
    if (input.includes('#')) {
        input = input.split('#')[0].trim();
    }

    return input;
}

// 根据协议自动切换反代模式
function switchProxyModeByProtocol(input, cleanAddress) {
    const lowerInput = input.toLowerCase();

    // 检查是否包含socks5协议
    if (lowerInput.includes('socks5://') || lowerInput.includes('socks5=') || lowerInput.startsWith('/socks')) {
        // 切换到SOCKS5模式
        document.getElementById('proxyMode').value = 'socks5';

        // 清空其他模式的内容，填充SOCKS5
        document.getElementById('proxyIP').value = '';
        document.getElementById('socks5Addr').value = cleanAddress;
        document.getElementById('httpAddr').value = '';
        document.getElementById('httpsAddr').value = '';

        updateProxyMode();
        return;
    }

    // 检查是否包含https协议
    if (lowerInput.includes('https://') || lowerInput.includes('https=') || lowerInput.startsWith('/https')) {
        // 切换到HTTPS模式
        document.getElementById('proxyMode').value = 'https';

        // 清空其他模式的内容，填充HTTPS
        document.getElementById('proxyIP').value = '';
        document.getElementById('socks5Addr').value = '';
        document.getElementById('httpAddr').value = '';
        document.getElementById('httpsAddr').value = cleanAddress;

        updateProxyMode();
        return;
    }

    // 检查是否包含http协议
    if (lowerInput.includes('http://') || lowerInput.includes('http=') || lowerInput.startsWith('/http')) {
        // 切换到HTTP模式
        document.getElementById('proxyMode').value = 'http';

        // 清空其他模式的内容，填充HTTP
        document.getElementById('proxyIP').value = '';
        document.getElementById('socks5Addr').value = '';
        document.getElementById('httpAddr').value = cleanAddress;
        document.getElementById('httpsAddr').value = '';

        updateProxyMode();
        return;
    }
}

function updateProxyMode(markSectionModified = true) {
    const mode = document.getElementById('proxyMode').value;
    const allowHttpsMode = mode === 'https' && httpsProxyFeatureEnabled;
    document.getElementById('proxyIPSection').style.display = mode === 'auto' ? 'block' : 'none';
    document.getElementById('socks5Section').style.display = mode === 'socks5' ? 'block' : 'none';
    document.getElementById('httpSection').style.display = mode === 'http' ? 'block' : 'none';
    document.getElementById('httpsSection').style.display = allowHttpsMode ? 'block' : 'none';

    // 根据选择的模式填充对应的数据
    if (mode === 'auto') {
        document.getElementById('proxyIP').value = currentConfig.反代?.PROXYIP || '';
        document.getElementById('autoProxy').checked = (currentConfig.反代?.PROXYIP === 'auto');
        if (currentConfig.反代?.PROXYIP === 'auto') {
            document.getElementById('proxyIP').disabled = true;
        } else {
            document.getElementById('proxyIP').disabled = false;
        }
    } else if (mode === 'socks5') {
        document.getElementById('socks5Addr').value = currentConfig.反代?.SOCKS5?.账号 || '';
        document.getElementById('globalSocks5').checked = currentConfig.反代?.SOCKS5?.全局 || false;
    } else if (mode === 'http') {
        document.getElementById('httpAddr').value = currentConfig.反代?.SOCKS5?.账号 || '';
        document.getElementById('globalHTTP').checked = currentConfig.反代?.SOCKS5?.全局 || false;
    } else if (mode === 'https') {
        document.getElementById('httpsAddr').value = currentConfig.反代?.SOCKS5?.账号 || '';
        document.getElementById('globalHTTPS').checked = currentConfig.反代?.SOCKS5?.全局 || false;
    }

    // 更新 "获取更多PROXYIP" 按钮的显示状态
    const getMoreBtn = document.getElementById('getMoreProxyIPBtn');
    if (getMoreBtn) {
        getMoreBtn.style.display = mode === 'auto' ? 'inline-block' : 'none';
    }

    // 更新 "探索更多SOCKS5" 按钮的显示状态
    const exploreSocks5Btn = document.getElementById('exploreSocks5Btn');
    if (exploreSocks5Btn) {
        exploreSocks5Btn.style.display = mode === 'socks5' ? 'inline-block' : 'none';
    }

    // 更新 "探索更多HTTP" 按钮的显示状态
    const exploreHTTPBtn = document.getElementById('exploreHTTPBtn');
    if (exploreHTTPBtn) {
        exploreHTTPBtn.style.display = mode === 'http' ? 'inline-block' : 'none';
    }

    // 更新 "探索更多HTTPS" 按钮的显示状态
    const exploreHTTPSBtn = document.getElementById('exploreHTTPSBtn');
    if (exploreHTTPSBtn) {
        exploreHTTPSBtn.style.display = allowHttpsMode ? 'inline-block' : 'none';
    }

    if (markSectionModified) {
        markModified('proxy');
    }
}

function toggleAutoProxy() {
    const autoProxy = document.getElementById('autoProxy').checked;
    document.getElementById('proxyIP').disabled = autoProxy;
    markModified('proxy');
}

function clearHeightTransition(content) {
    if (content && content._transitionHandler) {
        content.removeEventListener('transitionend', content._transitionHandler);
        content._transitionHandler = null;
    }
}

function animateSectionHeight(content, expand) {
    if (!content) return;

    clearHeightTransition(content);

    content.style.display = 'block';
    content.style.overflow = 'hidden';
    const startHeight = content.getBoundingClientRect().height;
    content.style.height = startHeight + 'px';
    content.getBoundingClientRect();

    const targetHeight = expand ? content.scrollHeight : 0;
    if (Math.abs(targetHeight - startHeight) < 1) {
        if (expand) {
            content.style.height = 'auto';
            content.style.overflow = 'visible';
        } else {
            content.style.display = 'none';
            content.style.height = '0px';
            content.style.overflow = 'hidden';
        }
        return;
    }

    content.style.height = targetHeight + 'px';

    const onEnd = function (e) {
        if (e.propertyName !== 'height') return;
        content.removeEventListener('transitionend', onEnd);
        content._transitionHandler = null;

        if (expand) {
            content.style.height = 'auto';
            content.style.overflow = 'visible';
        } else {
            content.style.display = 'none';
            content.style.height = '0px';
            content.style.overflow = 'hidden';
        }
    };

    content._transitionHandler = onEnd;
    content.addEventListener('transitionend', onEnd);
}

function toggleModule(titleEl) {
    const module = titleEl.parentElement;
    const content = module.querySelector('.module-content');

    // If there's no collapsible content, just toggle the class
    if (!content) {
        module.classList.toggle('collapsed');
        saveModuleStates();
        return;
    }

    const isCollapsed = module.classList.contains('collapsed');

    if (isCollapsed) {
        // 检查是否是网络模块，如果是则加载数据
        if (module.querySelector('.network-cards-container') && !networkInfoLoaded) {
            loadNetworkInfo();
        }

        module.classList.remove('collapsed');
        animateSectionHeight(content, true);
        if (module.id === 'cfUsageModule') {
            updateCountdown(true);
        }
    } else {
        module.classList.add('collapsed');
        animateSectionHeight(content, false);
    }

    // 保存模块状态到 localStorage
    saveModuleStates();
}

// 网络信息模块的折叠/展开函数
function toggleNetworkModule(titleEl) {
    const content = document.getElementById('network-module-content');
    const icon = titleEl.querySelector('.collapse-icon');

    const isHidden = content.style.display === 'none' || getComputedStyle(content).display === 'none';

    if (isHidden) {
        // Expand - show latency tests and start testing
        animateSectionHeight(content, true);

        if (icon) {
            icon.style.transform = 'rotate(0deg)';
        }

        // 生成卡片并开始测试
        startLatencyTest();
    } else {
        // Collapse - hide latency tests
        stopLatencyTest();
        animateSectionHeight(content, false);

        if (icon) {
            icon.style.transform = 'rotate(90deg)';
        }
    }
}

// 规范化PATH字段
function normalizePath(path) {
    // 如果为空，返回原值
    if (!path) return path;

    // 移除 '#' 及其之后的所有内容（注释）
    let normalizedPath = path.split('#')[0];

    // 去除首尾空格
    normalizedPath = normalizedPath.trim();

    // 如果第一个字符不是 '/'，则添加 '/'
    if (normalizedPath && !normalizedPath.startsWith('/')) {
        normalizedPath = '/' + normalizedPath;
    }

    return normalizedPath;
}

// 处理PATH输入完成后的规范化
function handlePathChange() {
    const nodePathInput = document.getElementById('nodePATH');
    const originalValue = nodePathInput.value;
    const normalizedValue = normalizePath(originalValue);

    // 如果规范化后的值与原值不同，更新输入框
    if (normalizedValue !== originalValue) {
        nodePathInput.value = normalizedValue;
    }

    // 标记为已修改
    markModified('config');
}

function markModified(section) {
    modifiedSections.add(section);

    // 特殊处理 notification 部分：更新 TG.启用 状态
    if (section === 'notification') {
        const telegramCheckbox = document.getElementById('telegramEnabled');
        if (!currentConfig.TG) currentConfig.TG = {};
        currentConfig.TG.启用 = telegramCheckbox.checked;
    }

    updateButtonStates();
}

function updateButtonStates() {
    // 订阅生成模块
    const subModified = modifiedSections.has('sub');
    document.getElementById('saveSubBtn').disabled = !subModified;
    document.getElementById('cancelSubBtn').disabled = !subModified;

    // 配置信息模块
    const configModified = modifiedSections.has('config');
    document.getElementById('saveConfigBtn').disabled = !configModified;
    document.getElementById('cancelConfigBtn').disabled = !configModified;

    // ECH设置模块
    const echModified = modifiedSections.has('ech');
    document.getElementById('saveEchBtn').disabled = !echModified;
    document.getElementById('cancelEchBtn').disabled = !echModified;

    // 反代设置模块
    const proxyModified = modifiedSections.has('proxy');
    document.getElementById('saveProxyBtn').disabled = !proxyModified;
    document.getElementById('cancelProxyBtn').disabled = !proxyModified;

    // 订阅转换模块
    const convertModified = modifiedSections.has('convert');
    document.getElementById('saveConvertBtn').disabled = !convertModified;
    document.getElementById('cancelConvertBtn').disabled = !convertModified;

    // 通知设置模块
    const notificationModified = modifiedSections.has('notification');
    document.getElementById('saveNotificationBtn').disabled = !notificationModified;
    document.getElementById('cancelNotificationBtn').disabled = !notificationModified;
}

function resetAllButtons() {
    document.querySelectorAll('[id^="save"]').forEach(btn => btn.disabled = true);
    document.querySelectorAll('[id^="cancel"]').forEach(btn => btn.disabled = true);
}

function copySubscription(elementId) {
    const element = document.getElementById(elementId);
    navigator.clipboard.writeText(element.value).then(() => {
        showToast('📋 已复制到剪贴板', 'success');
    }).catch(() => {
        showToast('复制失败', 'error');
    });
}

function handleTLSFragmentChange(type) {
    const shadowrocket = document.getElementById('tlsFragmentShadowrocket');
    const happ = document.getElementById('tlsFragmentHapp');

    if (type === 'Shadowrocket') {
        if (shadowrocket.checked) {
            happ.checked = false;
        }
    } else if (type === 'Happ') {
        if (happ.checked) {
            shadowrocket.checked = false;
        }
    }
}

function showQRCode(elementId) {
    const text = document.getElementById(elementId).value;
    const container = document.getElementById('qrcodeContainer');
    container.innerHTML = '';

    // 如果文本过长，使用较低的纠错等级来支持更长的内容
    let correctLevel = QRCode.CorrectLevel.H;
    if (text.length > 1500) {
        correctLevel = QRCode.CorrectLevel.M;
    }
    if (text.length > 2500) {
        correctLevel = QRCode.CorrectLevel.L;
    }

    try {
        new QRCode(container, {
            text: text,
            width: 300,
            height: 300,
            colorDark: '#000',
            colorLight: '#fff',
            correctLevel: correctLevel
        });
        document.getElementById('qrcodeModal').classList.add('show');
    } catch (error) {
        // 如果文本过长，显示错误提示
        console.error('二维码生成失败:', error);
        showToast('链接过长，无法生成二维码。联系项目作者修复问题。', 'error');
        container.innerHTML = '<div style="padding:20px;text-align:center;color:#f44336;">二维码生成失败：内容过长</div>';
    }
}

function closeQRCode(event) {
    if (!event || event.target.id === 'qrcodeModal') {
        document.getElementById('qrcodeModal').classList.remove('show');
    }
}

function handleSkipVerifyChange(event) {
    if (event.target.checked) {
        // 显示警告弹窗
        event.target.checked = false; // 先取消勾选
        document.getElementById('skipVerifyWarningModal').classList.add('show');
    } else {
        markModified('config');
    }
}

function closeSkipVerifyWarning(event) {
    if (!event || event.target.id === 'skipVerifyWarningModal') {
        document.getElementById('skipVerifyWarningModal').classList.remove('show');
    }
}

function confirmSkipVerify() {
    document.getElementById('skipVerify').checked = true;
    markModified('config');
    closeSkipVerifyWarning();
}

// HOSTS 编辑模态框相关函数
function openHostsEditModal(event) {
    if (event) event.stopPropagation();
    const modal = document.getElementById('hostsEditModal');
    const textarea = document.getElementById('hostsEditTextarea');

    // 将 HOSTS 数组内容填入文本框，每行一个
    if (currentConfig.HOSTS && Array.isArray(currentConfig.HOSTS)) {
        textarea.value = currentConfig.HOSTS.join('\n');
    } else {
        textarea.value = '';
    }

    modal.classList.add('show');
    textarea.focus();
}

function closeHostsEditModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('hostsEditModal');
    modal.classList.remove('show');
}

function confirmHostsEdit() {
    const textarea = document.getElementById('hostsEditTextarea');
    const nodeHostInput = document.getElementById('nodeHost');

    // 将文本框内容按 逗号、中文逗号 和 换行 分割成数组
    const text = textarea.value;
    // 使用正则表达式，将 , 、， 和 \n 都作为分隔符
    const items = text.split(/[ ,，。\n]+/)
        .map(item => cleanHostDomain(item.trim()))
        .filter(item => item.length > 0);

    if (items.length === 0) {
        showToast('请至少输入一个域名', 'error');
        return;
    }

    // 更新 currentConfig.HOSTS 数组
    currentConfig.HOSTS = items;

    // 更新输入框显示（用逗号连接）
    nodeHostInput.value = items.join('、');

    // 关闭模态框
    closeHostsEditModal();

    // 标记配置已修改
    markModified('config');

    showToast('域名列表已更新，请保存配置', 'success');
}

// 清理域名格式：去掉协议、路径、端口号，只保留纯域名
function cleanHostDomain(input) {
    if (!input) return '';

    let domain = input;

    // 去掉协议前缀 (http:// 或 https://)
    domain = domain.replace(/^https?:\/\//i, '');

    // 去掉路径部分（第一个 / 及之后的内容）
    const slashIndex = domain.indexOf('/');
    if (slashIndex !== -1) {
        domain = domain.substring(0, slashIndex);
    }

    // 去掉端口号（: 及之后的数字）
    domain = domain.replace(/:\d+$/, '');

    return domain.trim();
}

async function saveSub() {
    const mode = document.getElementById('ipMode').value;

    // 检查文本框内容是否为空
    if (mode === 'random') {
        const randomCount = document.getElementById('randomCount').value.trim();
        if (!randomCount) {
            showToast('随机优选数量不能为空', 'error');
            return;
        }
    } else if (mode === 'custom') {
        const customIPs = document.getElementById('customIPs').value.trim();
        if (!customIPs) {
            showToast('自定义优选地址不能为空', 'error');
            return;
        }
    } else if (mode === 'generator') {
        const generatorURL = document.getElementById('generatorURL').value.trim();
        if (!generatorURL) {
            showToast('优选订阅生成器地址不能为空', 'error');
            return;
        }
    }

    const updates = {
        local: mode !== 'generator',
        本地IP库: { 随机IP: mode === 'random', 随机数量: parseInt(document.getElementById('randomCount').value) || 16 },
        SUB: mode === 'generator' ? document.getElementById('generatorURL').value : null,
        SUBNAME: currentConfig.优选订阅生成.SUBNAME,
        SUBUpdateTime: currentConfig.优选订阅生成.SUBUpdateTime,
        TOKEN: currentConfig.优选订阅生成.TOKEN
    };

    // 如果指定端口存在，添加到本地IP库
    if (currentConfig.优选订阅生成?.本地IP库?.指定端口 !== undefined) {
        updates.本地IP库.指定端口 = parseInt(document.getElementById('specifiedPort').value);
    }

    currentConfig.优选订阅生成 = { ...currentConfig.优选订阅生成, ...updates };

    if (mode === 'custom') {
        const customIPs = document.getElementById('customIPs').value;
        try {
            await fetch('/admin/ADD.txt', { method: 'POST', body: customIPs });
        } catch (error) {
            showToast('保存自定义IP失败', 'error');
            return;
        }
    }

    await saveConfigToServer('sub');
}

async function saveConfig() {
    currentConfig.优选订阅生成.SUBNAME = document.getElementById('subName').value;
    currentConfig.协议类型 = document.getElementById('protocol').value;
    const ssMethodSelect = document.getElementById('ssMethod');
    const ssTLSSelect = document.getElementById('ssTLS');
    if (currentConfig.SS && typeof currentConfig.SS === 'object' && ssMethodSelect && ssTLSSelect) {
        const ssMethodKey = '\u52a0\u5bc6\u65b9\u5f0f';
        currentConfig.SS[ssMethodKey] = ssMethodSelect.value || 'aes-128-gcm';
        currentConfig.SS.TLS = ssTLSSelect.value === 'true';
    }
    if (currentConfig['gRPC模式'] !== undefined) {
        currentConfig['传输协议'] = document.getElementById('transport').value;
        currentConfig['gRPC模式'] = document.getElementById('grpcMode').value || 'gun';
    }
    if (currentConfig['gRPCUserAgent'] !== undefined) {
        const grpcUserAgentInput = document.getElementById('grpcUserAgent');
        if (grpcUserAgentInput) {
            // 保存前兜底：如果去除空格后为空，自动填入当前UA
            if (!grpcUserAgentInput.value.replace(/\s+/g, '')) {
                grpcUserAgentInput.value = navigator.userAgent || '';
            }
            currentConfig['gRPCUserAgent'] = grpcUserAgentInput.value || '';
        }
    }
    currentConfig.跳过证书验证 = document.getElementById('skipVerify').checked;

    // 保存PATH（如果"完整节点路径"字段存在，表示后端支持编辑PATH）
    if (currentConfig['完整节点路径'] !== undefined) {
        currentConfig.PATH = document.getElementById('nodePATH').value;
    }

    // 保存Fingerprint（如果字段存在）
    if (currentConfig['Fingerprint'] !== undefined) {
        currentConfig['Fingerprint'] = document.getElementById('fingerprint').value;
    }

    // 保存随机路径（如果字段存在）
    if (currentConfig['随机路径'] !== undefined) {
        currentConfig['随机路径'] = document.getElementById('randomPath').checked;
    }

    // 保存启用0RTT（如果字段存在）
    if (currentConfig['启用0RTT'] !== undefined) {
        currentConfig['启用0RTT'] = document.getElementById('enable0RTT').checked;
    }

    // 保存TLS分片（如果字段存在）
    if (currentConfig['TLS分片'] !== undefined) {
        const shadowrocket = document.getElementById('tlsFragmentShadowrocket').checked;
        const happ = document.getElementById('tlsFragmentHapp').checked;

        if (shadowrocket) {
            currentConfig['TLS分片'] = 'Shadowrocket';
        } else if (happ) {
            currentConfig['TLS分片'] = 'Happ';
        } else {
            currentConfig['TLS分片'] = null;
        }
    }

    await saveConfigToServer('config');
    // 更新网页标题
    document.title = `${currentConfig.优选订阅生成?.SUBNAME || 'edgetunnel'}设置页面 - 管理后台`;
}

async function saveEch() {
    // 保存ECH（如果字段存在）
    if (currentConfig['ECH'] !== undefined) {
        currentConfig['ECH'] = document.getElementById('enableECH').checked;

        // 保存ECHConfig.DNS（如果存在）
        if (currentConfig.ECHConfig?.DNS !== undefined) {
            const dnsValue = document.getElementById('echDNSValue').value;
            if (dnsValue) {
                currentConfig.ECHConfig.DNS = dnsValue;
            }
        }

        // 保存ECHConfig.SNI（如果存在）
        if (currentConfig.ECHConfig?.SNI !== undefined) {
            const sniValue = document.getElementById('echSNIValue').value;
            currentConfig.ECHConfig.SNI = sniValue === '' ? null : sniValue;
        }
    }

    await saveConfigToServer('ech');
}

async function saveProxy() {
    const mode = document.getElementById('proxyMode').value;
    let socksEnabled = null;
    let socksAccount = '';
    let globalProxy = false;
    let proxyIP = currentConfig.反代.PROXYIP;

    // 检查文本框内容是否为空
    if (mode === 'auto') {
        socksEnabled = null;
        const autoProxy = document.getElementById('autoProxy').checked;
        proxyIP = autoProxy ? 'auto' : document.getElementById('proxyIP').value.trim();

        if (!autoProxy && !proxyIP) {
            showToast('PROXYIP地址不能为空', 'error');
            return;
        }
    } else if (mode === 'socks5') {
        socksEnabled = 'socks5';
        socksAccount = document.getElementById('socks5Addr').value.trim();
        globalProxy = document.getElementById('globalSocks5').checked;

        if (!socksAccount) {
            showToast('SOCKS5地址不能为空', 'error');
            return;
        }
    } else if (mode === 'http') {
        socksEnabled = 'http';
        socksAccount = document.getElementById('httpAddr').value.trim();
        globalProxy = document.getElementById('globalHTTP').checked;

        if (!socksAccount) {
            showToast('HTTP地址不能为空', 'error');
            return;
        }
    } else if (mode === 'https') {
        if (!httpsProxyFeatureEnabled) {
            showToast('当前后端版本暂不支持HTTPS反代', 'error');
            return;
        }
        socksEnabled = 'https';
        socksAccount = document.getElementById('httpsAddr').value.trim();
        globalProxy = document.getElementById('globalHTTPS').checked;

        if (!socksAccount) {
            showToast('HTTPS地址不能为空', 'error');
            return;
        }
    }

    currentConfig.反代 = {
        PROXYIP: proxyIP,
        SOCKS5: {
            启用: socksEnabled,
            全局: globalProxy,
            账号: socksAccount,
            白名单: currentConfig.反代.SOCKS5.白名单
        }
    };

    await saveConfigToServer('proxy');
}

// 加载SubConfig JSON数据
async function loadSubConfigData() {
    try {
        const url = 'https://raw.githubusercontent.com/cmliu/cmliu/main/SUBCONFIG.json';
        const text = await fetchWithAutoMirror(url, 'SubConfig');
        subConfigData = JSON.parse(text);
        populateSubConfigSelect();
        console.log('[订阅转换配置列表] SUBCONFIG 数据加载成功');
    } catch (error) {
        console.error('Error loading SubConfig:', error);
        // 加载失败时，仍然显示下拉框（只有自定义选项）
        subConfigData = null;
        populateSubConfigSelect();
    }
}

// 填充SubConfig下拉框
function populateSubConfigSelect() {
    const select = document.getElementById('subConfigSelect');
    const customInput = document.getElementById('subConfigCustomInput');
    if (!select) return; // 元素还不存在，等待后续调用

    // 始终添加"自定义"选项作为第一项
    select.innerHTML = '<option value="custom">&nbsp;&nbsp;&nbsp;&nbsp;自定义</option>';

    // 如果有数据，添加分组选项
    if (subConfigData && Array.isArray(subConfigData)) {
        subConfigData.forEach(group => {
            const optgroup = document.createElement('optgroup');
            optgroup.label = group.label;

            if (group.options && Array.isArray(group.options)) {
                group.options.forEach(option => {
                    const opt = document.createElement('option');
                    opt.value = option.value;
                    opt.textContent = option.label;
                    optgroup.appendChild(opt);
                });
            }

            select.appendChild(optgroup);
        });
    }

    // 显示下拉框
    select.style.display = 'block';

    // 如果已有保存的配置值，设置选中状态
    const savedSubConfig = currentConfig.订阅转换配置?.SUBCONFIG || '';
    if (savedSubConfig) {
        // 尝试在下拉框中找到匹配的选项
        select.value = savedSubConfig;

        // 如果没有匹配到（值不在列表中），选择"自定义"并显示输入框
        if (select.value !== savedSubConfig) {
            select.value = 'custom';
            customInput.value = savedSubConfig;
            customInput.style.display = 'block';
            document.getElementById('subConfig').value = savedSubConfig;
        } else {
            // 匹配成功，隐藏自定义输入框
            customInput.style.display = 'none';
            customInput.value = '';
            document.getElementById('subConfig').value = savedSubConfig;
        }
    } else {
        // 没有保存值，默认选择"自定义"
        select.value = 'custom';
        customInput.style.display = 'block';
    }

    // 设置change事件监听
    select.onchange = function () {
        if (this.value === 'custom') {
            // 选择自定义，显示输入框
            customInput.style.display = 'block';
            document.getElementById('subConfig').value = customInput.value;
        } else {
            // 选择预设值，隐藏输入框并更新值
            customInput.style.display = 'none';
            customInput.value = '';
            document.getElementById('subConfig').value = this.value;
        }
        markModified('convert');
    };
}

// 自定义输入框变化时的处理
function onSubConfigCustomInput() {
    const customInput = document.getElementById('subConfigCustomInput');
    document.getElementById('subConfig').value = customInput.value;
    markModified('convert');
}

async function saveConvert() {
    currentConfig.订阅转换配置 = {
        SUBAPI: document.getElementById('subAPI').value,
        SUBCONFIG: document.getElementById('subConfig').value,
        SUBEMOJI: document.getElementById('emoji').checked
    };

    await saveConfigToServer('convert');
}

async function saveConfigToServer(section) {
    try {
        const response = await fetch('/admin/config.json', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            },
            body: JSON.stringify(currentConfig)
        });

        if (!response.ok) throw new Error('保存失败');
        showToast('✅ 配置已保存，请更新订阅，才能获取最新节点内容！', 'success');
        modifiedSections.delete(section);
        updateButtonStates();
    } catch (error) {
        showToast('😢 ' + error.message + '，请检测网络环境，或关闭代理后再试！', 'error');
    }
}

function cancelEdit(section) {
    currentConfig = JSON.parse(JSON.stringify(originalConfig));

    // 只重置该模块的值，不调用 renderUI 以保持展开状态
    if (section === 'sub') {
        const local = currentConfig.优选订阅生成?.local ?? true;
        const randomIP = currentConfig.优选订阅生成?.本地IP库?.随机IP ?? true;

        if (!local) {
            document.getElementById('ipMode').value = 'generator';
            document.getElementById('generatorURL').value = currentConfig.优选订阅生成?.SUB || '';
        } else if (randomIP) {
            document.getElementById('ipMode').value = 'random';
            document.getElementById('randomCount').value = currentConfig.优选订阅生成?.本地IP库?.随机数量 || 16;
            // 设置指定端口
            if (currentConfig.优选订阅生成?.本地IP库?.指定端口 !== undefined) {
                document.getElementById('specifiedPort').value = currentConfig.优选订阅生成.本地IP库.指定端口;
            }
        } else {
            document.getElementById('ipMode').value = 'custom';
            loadCustomIPs();
        }
        updateIPMode();
    } else if (section === 'config') {
        document.getElementById('subName').value = currentConfig.优选订阅生成?.SUBNAME || '';
        document.getElementById('nodeHost').value = currentConfig.HOST || '';
        document.getElementById('nodeUUID').value = currentConfig.UUID || '';
        document.getElementById('nodePATH').value = currentConfig.PATH || '';
        syncSSProtocolSettingsFromConfig();
        document.getElementById('protocol').value = currentConfig.协议类型 || 'vless';
        syncTransportSettingsFromConfig();
        document.getElementById('skipVerify').checked = currentConfig.跳过证书验证 || false;

        // 处理PATH字段的只读状态
        const nodePathInput = document.getElementById('nodePATH');
        if (currentConfig['完整节点路径'] !== undefined) {
            nodePathInput.removeAttribute('readonly');
            nodePathInput.title = '节点的伪装路径';
            nodePathInput.onchange = handlePathChange;
        } else {
            nodePathInput.setAttribute('readonly', '');
            nodePathInput.title = '节点的伪装路径 仅可通过 \'PATH\'环境变量 进行修改';
            nodePathInput.onchange = null;
        }

        // 重置随机路径（如果字段存在）
        if (currentConfig['随机路径'] !== undefined) {
            document.getElementById('randomPath').checked = currentConfig['随机路径'] || false;
        }

        // 重置启用0RTT（如果字段存在）
        if (currentConfig['启用0RTT'] !== undefined) {
            document.getElementById('enable0RTT').checked = currentConfig['启用0RTT'] || false;
        }

        // 重置TLS分片（如果字段存在）
        if (currentConfig['TLS分片'] !== undefined) {
            document.getElementById('tlsFragmentShadowrocket').checked = currentConfig['TLS分片'] === 'Shadowrocket';
            document.getElementById('tlsFragmentHapp').checked = currentConfig['TLS分片'] === 'Happ';
        }

        // 重置ECH（如果字段存在）
        if (currentConfig['ECH'] !== undefined) {
            document.getElementById('enableECH').checked = currentConfig['ECH'] || false;

            // 重置ECHConfig的下拉框
            populateEchDNSSelect();
            populateEchSNISelect();
        }

        updateProtocol();
    } else if (section === 'ech') {
        // 重置ECH设置
        if (currentConfig['ECH'] !== undefined) {
            document.getElementById('enableECH').checked = currentConfig['ECH'] || false;

            // 重置ECHConfig的下拉框
            populateEchDNSSelect();
            populateEchSNISelect();
        }
    } else if (section === 'proxy') {
        const socksEnabled = currentConfig.反代?.SOCKS5?.启用;
        if (!socksEnabled) {
            document.getElementById('proxyMode').value = 'auto';
            document.getElementById('proxyIP').value = currentConfig.反代?.PROXYIP || '';
            document.getElementById('autoProxy').checked = (currentConfig.反代?.PROXYIP === 'auto');
            if (currentConfig.反代?.PROXYIP === 'auto') {
                document.getElementById('proxyIP').disabled = true;
            }
        } else if (socksEnabled === 'socks5') {
            document.getElementById('proxyMode').value = 'socks5';
            document.getElementById('socks5Addr').value = currentConfig.反代?.SOCKS5?.账号 || '';
            document.getElementById('globalSocks5').checked = currentConfig.反代?.SOCKS5?.全局 || false;
        } else if (socksEnabled === 'http') {
            document.getElementById('proxyMode').value = 'http';
            document.getElementById('httpAddr').value = currentConfig.反代?.SOCKS5?.账号 || '';
            document.getElementById('globalHTTP').checked = currentConfig.反代?.SOCKS5?.全局 || false;
        } else if (socksEnabled === 'https') {
            document.getElementById('proxyMode').value = 'https';
            document.getElementById('httpsAddr').value = currentConfig.反代?.SOCKS5?.账号 || '';
            document.getElementById('globalHTTPS').checked = currentConfig.反代?.SOCKS5?.全局 || false;
        }
        updateProxyMode();
    } else if (section === 'convert') {
        document.getElementById('subAPI').value = currentConfig.订阅转换配置?.SUBAPI || '';
        document.getElementById('subConfig').value = currentConfig.订阅转换配置?.SUBCONFIG || '';
        document.getElementById('emoji').checked = currentConfig.订阅转换配置?.SUBEMOJI || false;
        // 重新填充下拉框以恢复正确的选中状态
        populateSubConfigSelect();
    }

    modifiedSections.delete(section);
    updateButtonStates();
}

// 保存模块展开/折叠状态到 localStorage
function saveModuleStates() {
    const states = {};
    document.querySelectorAll('.module').forEach((module, index) => {
        const title = module.querySelector('.module-title')?.textContent?.trim() || ('module-' + index);
        // 不保存"查看操作日志"和"当前网络信息"模块的状态
        if (title !== '📋 查看操作日志' && title !== '🌍 当前网络信息') {
            states[title] = !module.classList.contains('collapsed');
        }
    });
    localStorage.setItem('adminModuleStates', JSON.stringify(states));
}

// 从 localStorage 加载模块展开/折叠状态
function loadModuleStates() {
    const savedStates = localStorage.getItem('adminModuleStates');
    const states = savedStates ? JSON.parse(savedStates) : {};

    // 如果是第一次访问（localStorage中没有保存状态），所有模块默认折叠
    const isFirstVisit = !savedStates;

    document.querySelectorAll('.module').forEach((module, index) => {
        const title = module.querySelector('.module-title')?.textContent?.trim() || ('module-' + index);
        let shouldBeExpanded;

        // "查看操作日志"模块始终保持折叠状态，"当前网络信息"模块始终展开
        if (title === '📋 查看操作日志') {
            shouldBeExpanded = false;
        } else if (title === '🌍 当前网络信息') {
            shouldBeExpanded = true;
        } else {
            shouldBeExpanded = isFirstVisit ? false : (states[title] !== false); // 第一次默认折叠，之后按保存的状态
        }

        const isCurrentlyCollapsed = module.classList.contains('collapsed');
        const content = module.querySelector('.module-content');

        if (shouldBeExpanded && isCurrentlyCollapsed) {
            // 需要展开
            module.classList.remove('collapsed');
            if (content) {
                clearHeightTransition(content);
                content.style.display = 'block';
                content.style.height = 'auto';
                content.style.overflow = 'visible';
            }
        } else if (!shouldBeExpanded && !isCurrentlyCollapsed) {
            // 需要折叠
            module.classList.add('collapsed');
            if (content) {
                clearHeightTransition(content);
                content.style.display = 'none';
                content.style.height = '0px';
                content.style.overflow = 'hidden';
            }
        }
    });
}

async function refreshConfig() {
    await loadConfig();
    const loadTime = currentConfig.加载时间 || '未知';
    showToast(`配置已刷新 (加载时间: ${loadTime})`, 'success');
}

function resetConfigWithConfirm() {
    document.getElementById('resetModal').classList.add('show');
}

function closeResetModal(event) {
    if (event && event.target.id !== 'resetModal') return;
    document.getElementById('resetModal').classList.remove('show');
}

async function confirmReset() {
    try {
        const response = await fetch('/admin/init');
        if (!response.ok) throw new Error('重置失败');

        closeResetModal();
        showToast('配置已重置为默认值', 'success');

        // 延迟1秒后刷新页面，让用户看到成功提示
        setTimeout(() => {
            window.location.reload();
        }, 1000);
    } catch (error) {
        showToast('重置失败: ' + error.message, 'error');
    }
}

function logout() {
    window.location.href = '/logout';
}

// 切换用户模式（小白模式 / 高手模式）
function toggleUserMode() {
    const cardContainer = document.querySelector('.card-container');
    const btn = document.getElementById('modeToggleBtn');

    if (cardContainer.classList.contains('simple-mode')) {
        // 切换到高手模式
        cardContainer.classList.remove('simple-mode');
        btn.textContent = '🐣 我是小白！我想简单点！';
        localStorage.setItem('userMode', 'expert');
        showToast('🚀 已切换到高手模式，显示所有功能', 'success');
    } else {
        // 切换到小白模式
        cardContainer.classList.add('simple-mode');
        btn.textContent = '🚀 我是高手！我就要折腾！';
        localStorage.setItem('userMode', 'simple');
        showToast('🐣 已切换到小白模式，只显示常用功能', 'success');
    }

    // 使用 requestAnimationFrame 确保动画流畅
    requestAnimationFrame(() => {
        void cardContainer.offsetHeight;
    });
}

// 初始化用户模式
function initUserMode() {
    const userMode = localStorage.getItem('userMode') || 'simple'; // 默认为小白模式
    const cardContainer = document.querySelector('.card-container');
    const btn = document.getElementById('modeToggleBtn');

    if (userMode === 'simple') {
        cardContainer.classList.add('simple-mode');
        btn.textContent = '🚀 我是高手！我就要折腾！';
    } else {
        cardContainer.classList.remove('simple-mode');
        btn.textContent = '🐣 我是小白！我想简单点！';
    }
}

function showToast(message, type = 'info') {
    // 移除现有的toast
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
        existingToast.remove();
    }

    // 创建新的toast
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // 显示动画
    setTimeout(() => toast.classList.add('show'), 10);

    // 自动隐藏
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// UUID easter egg
const UUID_EASTER_CLICK_TARGET_COUNT = 10;
const UUID_EASTER_LONG_PRESS_TARGET_COUNT = 16;
const UUID_EASTER_HINT_START = 4;
const UUID_EASTER_MAX_INTERVAL = 1000;
const UUID_EASTER_RESET_DELAY = 1400;
const UUID_EASTER_LONG_PRESS_DELAY = 360;
const UUID_EASTER_LONG_PRESS_INTERVAL = 120;
const UUID_EASTER_FX_VERTICAL_OFFSET = 12;
const UUID_EASTER_GIFT_ICONS = ['🎁', '🎀', '🧧', '🎉'];
const UUID_EASTER_FIREWORK_PARTICLE_COUNT = 26;
const UUID_SNIPPETS_JS_URL = 'https://raw.githubusercontent.com/EDT-Pages/EDT.min.js/Snippets/EDT.min.js';
const UUID_SNIPPETS_DICT_URL = 'https://raw.githubusercontent.com/EDT-Pages/EDT.min.js/Snippets/字典.json';

let uuidEasterClickCount = 0;
let uuidEasterLastClickAt = 0;
let uuidEasterResetTimer = null;
let uuidEasterLongPressDelayTimer = null;
let uuidEasterLongPressIntervalTimer = null;
let uuidEasterActivePointerId = null;
let uuidEasterPointerX = NaN;
let uuidEasterPointerY = NaN;
let uuidEasterLongPressMode = false;
let uuidSnippetLoading = false;
let uuidSnippetDisplayProgressTimer = null;
let uuidSnippetDisplayPreviewTimer = null;
let uuidSnippetDisplayRevealFrame = null;
let uuidSnippetDisplayReleaseTimer = null;
let uuidSnippetDisplayToken = 0;
let uuidSnippetDisplayProgressValue = 0;
let uuidSnippetDisplayProgressTarget = 0;
let uuidSnippetRawCode = '';
const uuidSnippetLastLiteralVariants = new Map();

const UUID_SNIPPET_REVEAL_CHARSET = '01<>/\\\\{}[]=+-_*#@$%&ABCDEFGHJKLMNPQRSTUVWXYZ';
const UUID_SNIPPET_STATUS_TEXT = {
    boot: 'BOOT',
    sync: 'SYNC',
    bind: 'BIND',
    mesh: 'MESH',
    reveal: 'REVEAL',
    fail: 'FAIL'
};

function resetNodeUUIDEasterCount() {
    uuidEasterClickCount = 0;
    uuidEasterLastClickAt = 0;
    if (uuidEasterResetTimer) {
        clearTimeout(uuidEasterResetTimer);
        uuidEasterResetTimer = null;
    }
}

function stopNodeUUIDLongPress() {
    if (uuidEasterLongPressDelayTimer) {
        clearTimeout(uuidEasterLongPressDelayTimer);
        uuidEasterLongPressDelayTimer = null;
    }
    if (uuidEasterLongPressIntervalTimer) {
        clearInterval(uuidEasterLongPressIntervalTimer);
        uuidEasterLongPressIntervalTimer = null;
    }
    uuidEasterActivePointerId = null;
    uuidEasterLongPressMode = false;
}

function getNodeUUIDFxOrigin(clientX, clientY, fallbackEl) {
    const rect = fallbackEl.getBoundingClientRect();
    const baseX = Number.isFinite(clientX) ? clientX : rect.left + rect.width / 2;
    const baseY = Number.isFinite(clientY) ? clientY : rect.top + rect.height / 2;
    return {
        x: baseX,
        y: baseY - UUID_EASTER_FX_VERTICAL_OFFSET
    };
}

function showNodeUUIDGiftFountain(clientX, clientY, fallbackEl) {
    const origin = getNodeUUIDFxOrigin(clientX, clientY, fallbackEl);
    const fx = document.createElement('div');
    fx.className = 'uuid-gift-fx';
    fx.textContent = UUID_EASTER_GIFT_ICONS[Math.floor(Math.random() * UUID_EASTER_GIFT_ICONS.length)];
    fx.style.left = (origin.x + (Math.random() * 20 - 10)) + 'px';
    fx.style.top = (origin.y + (Math.random() * 10 - 5)) + 'px';
    fx.style.setProperty('--gift-x-drift', `${(Math.random() * 90 - 45).toFixed(1)}px`);
    fx.style.setProperty('--gift-y-lift', `${(140 + Math.random() * 40).toFixed(1)}px`);
    fx.style.setProperty('--gift-rotate', `${(Math.random() * 70 - 35).toFixed(1)}deg`);
    fx.style.setProperty('--gift-duration', `${(640 + Math.random() * 240).toFixed(0)}ms`);
    document.body.appendChild(fx);

    setTimeout(() => fx.remove(), 1300);
}

function showNodeUUIDRocketFirework(clientX, clientY, fallbackEl) {
    const origin = getNodeUUIDFxOrigin(clientX, clientY, fallbackEl);
    const launchX = origin.x + (Math.random() * 26 - 13);
    const launchY = origin.y + 12;

    const rocket = document.createElement('div');
    rocket.className = 'uuid-rocket-fx';
    rocket.textContent = '🚀';
    rocket.style.left = `${launchX}px`;
    rocket.style.top = `${launchY}px`;
    rocket.style.setProperty('--rocket-x-drift', `${(Math.random() * 34 - 17).toFixed(1)}px`);
    document.body.appendChild(rocket);

    setTimeout(() => {
        const burstX = launchX + (Math.random() * 16 - 8);
        const burstY = launchY - (188 + Math.random() * 34);

        const flash = document.createElement('div');
        flash.className = 'uuid-firework-flash';
        flash.style.left = `${burstX}px`;
        flash.style.top = `${burstY}px`;

        const ring = document.createElement('div');
        ring.className = 'uuid-firework-ring';
        ring.style.left = `${burstX}px`;
        ring.style.top = `${burstY}px`;

        const burst = document.createElement('div');
        burst.className = 'uuid-firework-burst';
        burst.style.left = `${burstX}px`;
        burst.style.top = `${burstY}px`;

        for (let i = 0; i < UUID_EASTER_FIREWORK_PARTICLE_COUNT; i++) {
            const angle = (Math.PI * 2 * i / UUID_EASTER_FIREWORK_PARTICLE_COUNT) + (Math.random() * 0.14 - 0.07);
            const distance = 78 + Math.random() * 86;
            const dx = Math.cos(angle) * distance;
            const dy = Math.sin(angle) * distance;

            const particle = document.createElement('span');
            particle.className = 'uuid-firework-particle';
            particle.style.setProperty('--dx', `${dx.toFixed(1)}px`);
            particle.style.setProperty('--dy', `${dy.toFixed(1)}px`);
            particle.style.setProperty('--hue', `${Math.floor(Math.random() * 360)}`);
            particle.style.setProperty('--particle-duration', `${(780 + Math.random() * 420).toFixed(0)}ms`);
            burst.appendChild(particle);
        }

        document.body.appendChild(flash);
        document.body.appendChild(ring);
        document.body.appendChild(burst);
        rocket.remove();

        setTimeout(() => {
            flash.remove();
            ring.remove();
            burst.remove();
        }, 1400);
    }, 560);

    setTimeout(() => rocket.remove(), 1700);
}

function sha224(s) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const r = (n, b) => ((n >>> b) | (n << (32 - b))) >>> 0;
    s = unescape(encodeURIComponent(s));
    const l = s.length * 8;
    s += String.fromCharCode(0x80);
    while ((s.length * 8) % 512 !== 448) s += String.fromCharCode(0);
    const h = [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4];
    const hi = Math.floor(l / 0x100000000);
    const lo = l & 0xFFFFFFFF;
    s += String.fromCharCode((hi >>> 24) & 0xFF, (hi >>> 16) & 0xFF, (hi >>> 8) & 0xFF, hi & 0xFF, (lo >>> 24) & 0xFF, (lo >>> 16) & 0xFF, (lo >>> 8) & 0xFF, lo & 0xFF);
    const w = [];
    for (let i = 0; i < s.length; i += 4) {
        w.push((s.charCodeAt(i) << 24) | (s.charCodeAt(i + 1) << 16) | (s.charCodeAt(i + 2) << 8) | s.charCodeAt(i + 3));
    }
    for (let i = 0; i < w.length; i += 16) {
        const x = new Array(64).fill(0);
        for (let j = 0; j < 16; j++) x[j] = w[i + j];
        for (let j = 16; j < 64; j++) {
            const s0 = r(x[j - 15], 7) ^ r(x[j - 15], 18) ^ (x[j - 15] >>> 3);
            const s1 = r(x[j - 2], 17) ^ r(x[j - 2], 19) ^ (x[j - 2] >>> 10);
            x[j] = (x[j - 16] + s0 + x[j - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h0] = h;
        for (let j = 0; j < 64; j++) {
            const S1 = r(e, 6) ^ r(e, 11) ^ r(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h0 + S1 + ch + K[j] + x[j]) >>> 0;
            const S0 = r(a, 2) ^ r(a, 13) ^ r(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h0 = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        for (let j = 0; j < 8; j++) {
            h[j] = (h[j] + (j === 0 ? a : j === 1 ? b : j === 2 ? c : j === 3 ? d : j === 4 ? e : j === 5 ? f : j === 6 ? g : h0)) >>> 0;
        }
    }
    let hex = '';
    for (let i = 0; i < 7; i++) {
        for (let j = 24; j >= 0; j -= 8) hex += ((h[i] >>> j) & 0xFF).toString(16).padStart(2, '0');
    }
    return hex;
}

function closeUUIDSnippetModal() {
    const modal = document.getElementById('uuidSnippetModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

function getUUIDSnippetDisplayElements() {
    return {
        stage: document.getElementById('uuidSnippetStage'),
        textarea: document.getElementById('uuidSnippetTextarea'),
        preview: document.getElementById('uuidSnippetPreview'),
        copyBtn: document.getElementById('uuidSnippetCopyBtn'),
        copyBtnLabel: document.getElementById('uuidSnippetCopyBtnLabel')
    };
}

function clearUUIDSnippetDisplayTimers() {
    if (uuidSnippetDisplayProgressTimer) {
        clearInterval(uuidSnippetDisplayProgressTimer);
        uuidSnippetDisplayProgressTimer = null;
    }
    if (uuidSnippetDisplayPreviewTimer) {
        clearInterval(uuidSnippetDisplayPreviewTimer);
        uuidSnippetDisplayPreviewTimer = null;
    }
    if (uuidSnippetDisplayReleaseTimer) {
        clearTimeout(uuidSnippetDisplayReleaseTimer);
        uuidSnippetDisplayReleaseTimer = null;
    }
    if (uuidSnippetDisplayRevealFrame) {
        cancelAnimationFrame(uuidSnippetDisplayRevealFrame);
        uuidSnippetDisplayRevealFrame = null;
    }
}

function setUUIDSnippetStageState(state) {
    const { stage } = getUUIDSnippetDisplayElements();
    if (!stage) {
        return;
    }
    stage.classList.remove('is-processing', 'is-revealing', 'is-ready', 'is-error');
    if (state) {
        stage.classList.add(`is-${state}`);
    }
}

function setUUIDSnippetDisplayStatus(label, meta, badgeKey) {
    const { copyBtn, copyBtnLabel } = getUUIDSnippetDisplayElements();
    if (copyBtn) {
        copyBtn.dataset.phase = badgeKey || 'boot';
        copyBtn.title = meta ? `${label}：${meta}` : (label || '');
        copyBtn.setAttribute('aria-label', meta ? `${label}：${meta}` : (label || ''));
    }
    if (copyBtnLabel && copyBtn?.disabled) {
        copyBtnLabel.textContent = badgeKey === 'fail' ? '源码重组失败' : '🔐 等待源码混淆重组';
    }
}

function setUUIDSnippetProgress(progress) {
    const { copyBtn } = getUUIDSnippetDisplayElements();
    uuidSnippetDisplayProgressValue = Math.max(0, Math.min(100, progress));
    if (copyBtn) {
        copyBtn.style.setProperty('--uuid-copy-progress', `${Math.max(uuidSnippetDisplayProgressValue, 2)}%`);
    }
}

function updateUUIDSnippetProcessingStage(targetProgress, badgeKey, label, meta) {
    uuidSnippetDisplayProgressTarget = Math.max(uuidSnippetDisplayProgressTarget, targetProgress);
    setUUIDSnippetDisplayStatus(label, meta, badgeKey);
}

function createUUIDSnippetRandom(seedText) {
    let seed = 2166136261;
    const text = String(seedText || 'vault');
    for (let i = 0; i < text.length; i++) {
        seed ^= text.charCodeAt(i);
        seed = Math.imul(seed, 16777619);
    }
    return function nextRandom() {
        seed += 0x6D2B79F5;
        let value = seed;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function buildUUIDSnippetLoadingFrame(uuidValue, frameIndex) {
    const verbs = ['sync', 'fold', 'mesh', 'seal', 'splice', 'phase', 'stream', 'prime'];
    const nouns = ['lattice', 'entropy', 'cipher', 'matrix', 'vault', 'signal', 'kernel', 'mirror'];
    const tags = ['SCAN', 'TRACE', 'PULSE', 'FOLD', 'LINK', 'HASH'];
    const compactUUID = (uuidValue || '').replace(/-/g, '').toUpperCase() || 'VOID0000';
    const random = createUUIDSnippetRandom(`${compactUUID}:${frameIndex}`);
    const pick = (pool) => pool[Math.floor(random() * pool.length) % pool.length];
    const sliceHex = (offset, size) => {
        const safeSize = Math.max(1, size);
        const start = offset % Math.max(compactUUID.length, safeSize);
        return (compactUUID.slice(start, start + safeSize) || compactUUID.slice(0, safeSize)).padEnd(safeSize, '0');
    };

    const lines = [
        `// Quantum vault handshake :: ${sliceHex(frameIndex, 4)}-${sliceHex(frameIndex + 4, 4)} :: frame ${String(frameIndex).padStart(2, '0')}`,
        `const shard_${sliceHex(frameIndex + 2, 6).toLowerCase()} = prism.${pick(verbs)}("${sliceHex(frameIndex + 8, 8)}");`
    ];

    for (let i = 0; i < 10; i++) {
        const term = `${pick(verbs)}_${pick(nouns)}`;
        const signature = sliceHex(frameIndex + i * 3, 6);
        const ratio = Math.floor(random() * 87 + 12);
        const lane = String(Math.floor(random() * 24)).padStart(2, '0');
        if (i % 3 === 0) {
            lines.push(`[${pick(tags)}] stream.${term}("${signature}") -> lane:${lane} | flux:${ratio}%`);
        } else if (i % 3 === 1) {
            lines.push(`mesh.${term}(${Math.floor(random() * 512)}, seed_${signature.toLowerCase()}, "${sliceHex(frameIndex + i, 10)}");`);
        } else {
            lines.push(`await vault.${pick(verbs)}("${sliceHex(frameIndex + i * 2, 12)}", entropy:${ratio.toString().padStart(2, '0')});`);
        }
    }

    lines.push(`// Identity lock :: ${compactUUID.slice(0, 8)} :: bandwidth ${Math.floor(random() * 41 + 59)} THz`);
    return lines.join('\n');
}

function normalizeUUIDSnippetCodeForDisplay(sourceCode) {
    return String(sourceCode || '').replace(/\t/g, '    ');
}

function extractUUIDSnippetPreviewSource(sourceCode) {
    const lines = normalizeUUIDSnippetCodeForDisplay(sourceCode)
        .split(/\r?\n/)
        .slice(0, 22);
    return lines.join('\n');
}

function getUUIDSnippetRevealChar(index, progress) {
    const randomValue = Math.abs(Math.sin((index + 1) * 12.9898 + progress * 78.233)) * 43758.5453;
    return UUID_SNIPPET_REVEAL_CHARSET[Math.floor(randomValue) % UUID_SNIPPET_REVEAL_CHARSET.length];
}

function buildUUIDSnippetRevealFrame(source, progress) {
    const safeSource = String(source || '');
    if (!safeSource) {
        return '';
    }

    const revealEdge = Math.floor(safeSource.length * progress);
    const scrambleZone = Math.max(12, Math.floor((1 - progress) * 96));
    let result = '';

    for (let i = 0; i < safeSource.length; i++) {
        const currentChar = safeSource[i];
        if (currentChar === '\n' || currentChar === '\r') {
            result += currentChar;
            continue;
        }
        if (currentChar === '\t') {
            result += '    ';
            continue;
        }
        if (currentChar === ' ') {
            result += ' ';
            continue;
        }

        if (i < revealEdge - scrambleZone) {
            result += currentChar;
        } else if (i <= revealEdge + scrambleZone) {
            result += progress > 0.985 ? currentChar : getUUIDSnippetRevealChar(i, progress);
        } else {
            result += getUUIDSnippetRevealChar(i + 17, progress);
        }
    }

    return result;
}

function startUUIDSnippetPresentation(uuidValue) {
    const { textarea, preview } = getUUIDSnippetDisplayElements();
    clearUUIDSnippetDisplayTimers();
    uuidSnippetRawCode = '';
    uuidSnippetDisplayToken += 1;
    uuidSnippetDisplayProgressTarget = 18;
    setUUIDSnippetProgress(3);
    setUUIDSnippetStageState('processing');
    setUUIDSnippetDisplayStatus(
        '已激活专属源码解码仓',
        `正在为 ${String(uuidValue || '').slice(0, 8) || '当前 UUID'} 建立加密通道`,
        'boot'
    );

    if (textarea) {
        textarea.value = '';
        textarea.scrollTop = 0;
    }
    if (preview) {
        preview.textContent = buildUUIDSnippetLoadingFrame(uuidValue, 0);
    }

    const currentToken = uuidSnippetDisplayToken;
    if (isLowPerformanceMode) {
        setUUIDSnippetProgress(45);
        if (preview) {
            preview.textContent = 'Low performance mode: generating dedicated Snippet.js...';
        }
        return currentToken;
    }
    let frameIndex = 1;
    uuidSnippetDisplayPreviewTimer = setInterval(() => {
        if (currentToken !== uuidSnippetDisplayToken) {
            return;
        }
        const { preview: livePreview } = getUUIDSnippetDisplayElements();
        if (livePreview) {
            livePreview.textContent = buildUUIDSnippetLoadingFrame(uuidValue, frameIndex);
        }
        frameIndex += 1;
    }, 120);

    uuidSnippetDisplayProgressTimer = setInterval(() => {
        if (currentToken !== uuidSnippetDisplayToken) {
            return;
        }
        const delta = uuidSnippetDisplayProgressTarget - uuidSnippetDisplayProgressValue;
        if (delta > 0.15) {
            setUUIDSnippetProgress(uuidSnippetDisplayProgressValue + Math.max(0.35, delta * 0.08));
        }
    }, 56);

    return currentToken;
}

function finishUUIDSnippetPresentation(finalScript, token) {
    if (token !== uuidSnippetDisplayToken) {
        return;
    }

    const { textarea, preview } = getUUIDSnippetDisplayElements();
    uuidSnippetRawCode = String(finalScript || '');
    const displayScript = normalizeUUIDSnippetCodeForDisplay(uuidSnippetRawCode);
    if (textarea) {
        textarea.value = displayScript;
        textarea.scrollTop = 0;
    }

    if (uuidSnippetDisplayProgressTimer) {
        clearInterval(uuidSnippetDisplayProgressTimer);
        uuidSnippetDisplayProgressTimer = null;
    }
    if (uuidSnippetDisplayPreviewTimer) {
        clearInterval(uuidSnippetDisplayPreviewTimer);
        uuidSnippetDisplayPreviewTimer = null;
    }

    setUUIDSnippetStageState('revealing');
    setUUIDSnippetDisplayStatus('源码晶格重组完成', '正在解除视觉掩码并写入真实 Snippet.js', 'reveal');

    const previewSource = extractUUIDSnippetPreviewSource(displayScript);
    if (isLowPerformanceMode) {
        if (preview) {
            preview.textContent = previewSource;
        }
        setUUIDSnippetProgress(100);
        setUUIDSnippetStageState('ready');
        setUUIDSnippetCopyButtonEnabled(true);
        return;
    }
    const revealStart = performance.now();
    const revealDuration = 1650;

    const animateReveal = (now) => {
        if (token !== uuidSnippetDisplayToken) {
            return;
        }

        const progress = Math.min(1, (now - revealStart) / revealDuration);
        const easedProgress = 1 - Math.pow(1 - progress, 3);

        if (preview) {
            preview.textContent = buildUUIDSnippetRevealFrame(previewSource, easedProgress);
        }
        setUUIDSnippetProgress(78 + easedProgress * 22);

        if (progress < 1) {
            uuidSnippetDisplayRevealFrame = requestAnimationFrame(animateReveal);
            return;
        }

        uuidSnippetDisplayRevealFrame = null;
        if (preview) {
            preview.textContent = previewSource;
        }
        setUUIDSnippetStageState('ready');
        setUUIDSnippetCopyButtonEnabled(true);
    };

    uuidSnippetDisplayRevealFrame = requestAnimationFrame(animateReveal);
}

function failUUIDSnippetPresentation(message, token) {
    if (token !== uuidSnippetDisplayToken) {
        return;
    }

    const { textarea, preview } = getUUIDSnippetDisplayElements();
    clearUUIDSnippetDisplayTimers();
    uuidSnippetRawCode = '';
    setUUIDSnippetStageState('processing');
    setUUIDSnippetDisplayStatus('源码生成失败', '远端内容未能完成解码，正在释放错误信息', 'fail');
    setUUIDSnippetProgress(100);

    if (preview) {
        preview.textContent = [
            '// Snippet.js decode aborted',
            `// ${message}`,
            '// 请稍后重试，或检查网络与 UUID 是否正常'
        ].join('\n');
    }

    if (textarea) {
        textarea.value = `生成失败：${message}`;
        textarea.scrollTop = 0;
    }

    uuidSnippetDisplayReleaseTimer = setTimeout(() => {
        if (token !== uuidSnippetDisplayToken) {
            return;
        }
        setUUIDSnippetStageState('error');
    }, 720);
}

function setUUIDSnippetCopyButtonEnabled(enabled) {
    const { copyBtn, copyBtnLabel } = getUUIDSnippetDisplayElements();
    if (copyBtn) {
        copyBtn.disabled = !enabled;
        if (enabled) {
            copyBtn.dataset.phase = 'ready';
            copyBtn.style.setProperty('--uuid-copy-progress', '100%');
            copyBtn.title = '复制已生成的专属 Snippet.js';
            copyBtn.setAttribute('aria-label', '复制已生成的专属 Snippet.js');
        }
    }
    if (copyBtnLabel && enabled) {
        copyBtnLabel.textContent = '📋 点击复制代码';
    }
}

function openUUIDSnippetModal() {
    const modal = document.getElementById('uuidSnippetModal');
    const textarea = document.getElementById('uuidSnippetTextarea');
    if (!modal || !textarea) {
        return;
    }

    modal.classList.add('show');
    if (uuidSnippetLoading) {
        return;
    }

    textarea.value = '';
    setUUIDSnippetCopyButtonEnabled(false);
    generateUUIDSnippetCode();
}

async function copyUUIDSnippetCode() {
    const textarea = document.getElementById('uuidSnippetTextarea');
    const code = uuidSnippetRawCode || (textarea ? textarea.value : '');
    if (!code) {
        showToast('暂无可复制代码', 'error');
        return;
    }

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(code);
        } else {
            const tempTextarea = document.createElement('textarea');
            tempTextarea.value = code;
            tempTextarea.setAttribute('readonly', '');
            tempTextarea.style.position = 'fixed';
            tempTextarea.style.opacity = '0';
            tempTextarea.style.pointerEvents = 'none';
            tempTextarea.style.left = '-9999px';
            document.body.appendChild(tempTextarea);
            tempTextarea.focus();
            tempTextarea.select();
            tempTextarea.setSelectionRange(0, tempTextarea.value.length);
            const copied = document.execCommand('copy');
            tempTextarea.remove();
            if (!copied) throw new Error('copy failed');
        }
        showToast('📋 Snippet.js 代码已复制', 'success');
    } catch (error) {
        showToast('复制失败，请手动复制代码', 'error');
    }
}

function replaceSnippetCredentials(sourceCode, userID) {
    const password = sha224(userID);
    const linePattern = /(const\s+userID\s*=\s*["'])([^"']*)(["']\s*,\s*Password\s*=\s*["'])([^"']*)(["']\s*;)/;
    if (!linePattern.test(sourceCode)) {
        throw new Error('未找到EDT.min.js中的userID与Password配置');
    }
    return sourceCode.replace(linePattern, `$1${userID}$3${password}$5`);
}

function encodeSnippetCharAsUnicodeEscape(char) {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

function escapeSnippetLiteralForRegExp(literal) {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function randomizeSnippetLiteralCase(literal) {
    const letterIndexes = [];
    for (let i = 0; i < literal.length; i++) {
        if (/[a-z]/i.test(literal[i])) {
            letterIndexes.push(i);
        }
    }

    if (!letterIndexes.length) {
        return { value: literal, changedLetters: 0 };
    }

    const forcedUpperIndex = letterIndexes[Math.floor(Math.random() * letterIndexes.length)];
    let changedLetters = 0;
    let value = '';

    for (let i = 0; i < literal.length; i++) {
        const currentChar = literal[i];
        if (!/[a-z]/i.test(currentChar)) {
            value += currentChar;
            continue;
        }

        const nextChar = (i === forcedUpperIndex || Math.random() < 0.5)
            ? currentChar.toUpperCase()
            : currentChar.toLowerCase();
        if (nextChar !== currentChar) {
            changedLetters += 1;
        }
        value += nextChar;
    }

    return { value, changedLetters };
}

function randomizeSnippetLiteralUnicodeEscapes(literal) {
    const forcedIndex = Math.floor(Math.random() * literal.length);
    let escapedChars = 0;
    let value = '';

    for (let i = 0; i < literal.length; i++) {
        const currentChar = literal[i];
        const shouldEscape = i === forcedIndex || Math.random() < 0.5;
        if (shouldEscape) {
            value += encodeSnippetCharAsUnicodeEscape(currentChar);
            escapedChars += 1;
        } else {
            value += currentChar;
        }
    }

    return { value, escapedChars };
}

function randomizeSnippetLiteralOccurrences(sourceCode, literal, options = {}) {
    const pattern = new RegExp(escapeSnippetLiteralForRegExp(literal), 'g');
    const matches = sourceCode.match(pattern);
    if (!matches || !matches.length) {
        return {
            code: sourceCode,
            occurrences: 0,
            escapedChars: 0,
            changedLetters: 0
        };
    }

    const lastSignature = uuidSnippetLastLiteralVariants.get(literal) || '';
    let variantSignature = '';
    let escapedChars = 0;
    let changedLetters = 0;
    let randomizedCode = sourceCode;

    for (let attempt = 0; attempt < 8; attempt++) {
        const signatureParts = [];
        escapedChars = 0;
        changedLetters = 0;
        randomizedCode = sourceCode.replace(pattern, () => {
            let variantValue = literal;
            if (options.randomizeCase) {
                const caseVariant = randomizeSnippetLiteralCase(variantValue);
                variantValue = caseVariant.value;
                changedLetters += caseVariant.changedLetters;
            }

            const unicodeVariant = randomizeSnippetLiteralUnicodeEscapes(variantValue);
            variantValue = unicodeVariant.value;
            escapedChars += unicodeVariant.escapedChars;
            signatureParts.push(variantValue);
            return variantValue;
        });

        variantSignature = signatureParts.join('||');
        if (variantSignature !== lastSignature) {
            break;
        }
    }

    uuidSnippetLastLiteralVariants.set(literal, variantSignature);
    return {
        code: randomizedCode,
        occurrences: matches.length,
        escapedChars,
        changedLetters
    };
}

function buildSnippetDictionaryMap(dictionaryData) {
    const allRaw = Array.isArray(dictionaryData?.ALL) ? dictionaryData.ALL : [];
    const edtRaw = Array.isArray(dictionaryData?.EDT) ? dictionaryData.EDT : [];

    const allChars = [...new Set(allRaw.filter(item => typeof item === 'string' && item.length > 0).map(item => item[0]))];
    const edtChars = [...new Set(edtRaw.filter(item => typeof item === 'string' && item.length > 0).map(item => item[0]))];

    if (!allChars.length || !edtChars.length) {
        throw new Error('字典内容无效');
    }
    if (allChars.length < edtChars.length) {
        throw new Error('字典ALL数量不足，无法完成不重复随机替换');
    }

    const randomizedAllChars = shuffleArray(allChars);
    const dictionaryMap = new Map();
    edtChars.forEach((char, index) => {
        dictionaryMap.set(char, randomizedAllChars[index]);
    });
    return dictionaryMap;
}

function applySnippetDictionary(sourceCode, dictionaryMap) {
    let result = '';
    for (const ch of sourceCode) {
        result += dictionaryMap.has(ch) ? dictionaryMap.get(ch) : ch;
    }
    return result;
}

function randomizeSnippetIndentationTabs(sourceCode) {
    let totalTabs = 0;
    let removedTabs = 0;
    let keptTabs = 0;
    let affectedLines = 0;

    const code = sourceCode.replace(/^\t+/gm, leadingTabs => {
        affectedLines += 1;
        let randomizedIndentation = '';

        for (const tabChar of leadingTabs) {
            totalTabs += 1;
            if (Math.random() < 0.5) {
                removedTabs += 1;
            } else {
                keptTabs += 1;
                randomizedIndentation += tabChar;
            }
        }

        return randomizedIndentation;
    });

    return {
        code,
        totalTabs,
        removedTabs,
        keptTabs,
        affectedLines
    };
}

async function generateUUIDSnippetCode() {
    if (uuidSnippetLoading) {
        return;
    }

    const textarea = document.getElementById('uuidSnippetTextarea');
    const nodeUUIDInput = document.getElementById('nodeUUID');
    if (!textarea || !nodeUUIDInput) {
        return;
    }

    const uuidValue = (nodeUUIDInput.value || '').trim();
    if (!uuidValue) {
        uuidSnippetRawCode = '';
        textarea.value = '';
        setUUIDSnippetCopyButtonEnabled(false);
        clearUUIDSnippetDisplayTimers();
        setUUIDSnippetStageState('');
        setUUIDSnippetProgress(0);
        setUUIDSnippetDisplayStatus('等待源码重组完成', '请先填写 UUID 再生成专属源码', 'boot');
        showToast('UUID为空，无法生成专属代码', 'error');
        return;
    }

    const animationToken = startUUIDSnippetPresentation(uuidValue);
    try {
        uuidSnippetLoading = true;
        updateUUIDSnippetProcessingStage(28, 'sync', '正在拉取原始 Snippet 内核', '远端源码流与字典矩阵已接入');
        const [rawScriptText, rawDictionaryText] = await Promise.all([
            fetchWithAutoMirror(UUID_SNIPPETS_JS_URL, 'Snippets EDT.min.js'),
            fetchWithAutoMirror(UUID_SNIPPETS_DICT_URL, 'Snippets 字典')
        ]);

        updateUUIDSnippetProcessingStage(51, 'sync', '远端内容捕获完成', `源码 ${rawScriptText.length} 字符，字典 ${rawDictionaryText.length} 字符`);
        const replacedScript = replaceSnippetCredentials(rawScriptText, uuidValue);
        updateUUIDSnippetProcessingStage(69, 'bind', '专属 UUID 指纹已注入', `用户标识 ${uuidValue.slice(0, 8)} 已锁定到内核`);
        const dictionaryData = JSON.parse(rawDictionaryText);
        const dictionaryMap = buildSnippetDictionaryMap(dictionaryData);
        updateUUIDSnippetProcessingStage(86, 'mesh', '字符晶格正在重映射', `字典矩阵已生成 ${dictionaryMap.size} 组替换通道`);
        const dictionaryAppliedScript = applySnippetDictionary(replacedScript, dictionaryMap);
        const socketsVariantResult = randomizeSnippetLiteralOccurrences(dictionaryAppliedScript, 'cloudflare:sockets');
        const proxyipVariantResult = randomizeSnippetLiteralOccurrences(
            socketsVariantResult.code,
            'proxyip.cmliussss.net',
            { randomizeCase: true }
        );
        const finalScript = proxyipVariantResult.code;
        const variantSummaries = [];

        if (socketsVariantResult.occurrences > 0) {
            variantSummaries.push(
                `cloudflare:sockets ${socketsVariantResult.occurrences} 处 / ${socketsVariantResult.escapedChars} 个 Unicode 转义`
            );
        }
        if (proxyipVariantResult.occurrences > 0) {
            variantSummaries.push(
                `proxyip.cmliussss.net ${proxyipVariantResult.occurrences} 处 / ${proxyipVariantResult.changedLetters} 个大小写扰动 / ${proxyipVariantResult.escapedChars} 个 Unicode 转义`
            );
        }

        if (variantSummaries.length > 0) {
            updateUUIDSnippetProcessingStage(94, 'mesh', '目标标识已完成随机扰动', variantSummaries.join(' ; '));
        } else {
            updateUUIDSnippetProcessingStage(94, 'mesh', '未发现目标标识', '跳过字符串扰动步骤，直接进入最终揭晓');
        }

        const indentationRandomizedResult = randomizeSnippetIndentationTabs(finalScript);
        if (indentationRandomizedResult.totalTabs > 0) {
            updateUUIDSnippetProcessingStage(
                97,
                'mesh',
                '源码缩进已完成随机排版',
                `影响 ${indentationRandomizedResult.affectedLines} 行 / 保留 ${indentationRandomizedResult.keptTabs} 个 tab / 删除 ${indentationRandomizedResult.removedTabs} 个 tab`
            );
        } else {
            updateUUIDSnippetProcessingStage(97, 'mesh', '未发现可扰动缩进', '源码中没有行首 tab，跳过随机排版步骤');
        }

        finishUUIDSnippetPresentation(indentationRandomizedResult.code, animationToken);
        showToast('Snippets.js专属代码已生成', 'success');
    } catch (error) {
        setUUIDSnippetCopyButtonEnabled(false);
        failUUIDSnippetPresentation(error.message || String(error), animationToken);
        showToast('生成失败: ' + (error.message || error), 'error');
    } finally {
        uuidSnippetLoading = false;
    }
}

async function copyNodeUUIDValue(nodeUUIDInput) {
    const uuidValue = (nodeUUIDInput.value || '').trim();
    if (!uuidValue) {
        showToast('UUID为空，无法复制', 'error');
        return;
    }

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(uuidValue);
            showToast('📋 已复制UUID的值', 'success');
            return;
        }

        const tempTextarea = document.createElement('textarea');
        tempTextarea.value = uuidValue;
        tempTextarea.setAttribute('readonly', '');
        tempTextarea.style.position = 'fixed';
        tempTextarea.style.opacity = '0';
        tempTextarea.style.pointerEvents = 'none';
        tempTextarea.style.left = '-9999px';
        document.body.appendChild(tempTextarea);
        tempTextarea.focus();
        tempTextarea.select();
        tempTextarea.setSelectionRange(0, tempTextarea.value.length);

        const copied = document.execCommand('copy');
        tempTextarea.remove();

        if (copied) {
            showToast('📋 已复制UUID的值', 'success');
        } else {
            showToast('复制失败，请手动复制UUID', 'error');
        }
    } catch (error) {
        showToast('复制失败，请手动复制UUID', 'error');
    }
}

function initNodeUUIDEasterEgg() {
    const nodeUUIDInput = document.getElementById('nodeUUID');
    if (!nodeUUIDInput) {
        return;
    }

    const triggerUUIDEaster = (clientX, clientY) => {
        const targetCount = uuidEasterLongPressMode
            ? UUID_EASTER_LONG_PRESS_TARGET_COUNT
            : UUID_EASTER_CLICK_TARGET_COUNT;

        const now = Date.now();

        if (now - uuidEasterLastClickAt > UUID_EASTER_MAX_INTERVAL) {
            uuidEasterClickCount = 0;
        }

        uuidEasterLastClickAt = now;
        uuidEasterClickCount += 1;

        if (uuidEasterResetTimer) {
            clearTimeout(uuidEasterResetTimer);
        }
        uuidEasterResetTimer = setTimeout(() => {
            resetNodeUUIDEasterCount();
        }, UUID_EASTER_RESET_DELAY);

        if (uuidEasterClickCount === 1) {
            copyNodeUUIDValue(nodeUUIDInput);
        }

        if (!isLowPerformanceMode && uuidEasterClickCount >= UUID_EASTER_HINT_START && uuidEasterClickCount < targetCount) {
            showNodeUUIDGiftFountain(clientX, clientY, nodeUUIDInput);
        }

        if (uuidEasterClickCount >= targetCount) {
            if (!isLowPerformanceMode) {
                showNodeUUIDRocketFirework(clientX, clientY, nodeUUIDInput);
            }
            openUUIDSnippetModal();
            resetNodeUUIDEasterCount();
            stopNodeUUIDLongPress();
            return true;
        }
        return false;
    };

    nodeUUIDInput.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }
        if (uuidEasterActivePointerId !== null && uuidEasterActivePointerId !== event.pointerId) {
            return;
        }

        if (event.pointerType !== 'mouse') {
            event.preventDefault();
        }

        stopNodeUUIDLongPress();
        uuidEasterActivePointerId = event.pointerId;
        uuidEasterPointerX = event.clientX;
        uuidEasterPointerY = event.clientY;
        if (nodeUUIDInput.setPointerCapture) {
            try {
                nodeUUIDInput.setPointerCapture(event.pointerId);
            } catch (_) {
                // ignore capture errors on unsupported platforms
            }
        }

        const reachedTarget = triggerUUIDEaster(uuidEasterPointerX, uuidEasterPointerY);
        if (reachedTarget) {
            return;
        }

        uuidEasterLongPressDelayTimer = setTimeout(() => {
            uuidEasterLongPressMode = true;
            uuidEasterLongPressIntervalTimer = setInterval(() => {
                triggerUUIDEaster(uuidEasterPointerX, uuidEasterPointerY);
            }, UUID_EASTER_LONG_PRESS_INTERVAL);
        }, UUID_EASTER_LONG_PRESS_DELAY);
    });

    nodeUUIDInput.addEventListener('pointermove', (event) => {
        if (uuidEasterActivePointerId !== event.pointerId) {
            return;
        }
        uuidEasterPointerX = event.clientX;
        uuidEasterPointerY = event.clientY;
    });

    const onPointerFinish = (event) => {
        if (uuidEasterActivePointerId !== null && uuidEasterActivePointerId !== event.pointerId) {
            return;
        }
        if (nodeUUIDInput.releasePointerCapture && event.pointerId !== undefined) {
            try {
                if (nodeUUIDInput.hasPointerCapture && nodeUUIDInput.hasPointerCapture(event.pointerId)) {
                    nodeUUIDInput.releasePointerCapture(event.pointerId);
                }
            } catch (_) {
                // ignore release errors
            }
        }
        stopNodeUUIDLongPress();
    };

    nodeUUIDInput.addEventListener('pointerup', onPointerFinish);
    nodeUUIDInput.addEventListener('pointercancel', onPointerFinish);
    nodeUUIDInput.addEventListener('lostpointercapture', onPointerFinish);
    nodeUUIDInput.addEventListener('blur', () => stopNodeUUIDLongPress());

    nodeUUIDInput.addEventListener('contextmenu', (event) => {
        if (uuidEasterActivePointerId !== null) {
            event.preventDefault();
        }
    });
}
// 日志类型翻译
function translateLogType(type, ua = '') {
    // 如果是 Get_SUB 类型，检查 UA 是否包含 subconverter
    if (type === 'Get_SUB') {
        const uaLowercase = (ua || '').toLowerCase();
        if (uaLowercase.includes('subconverter')) {
            return { text: '订阅转换', color: '#3b82f6' };
        }
        return { text: '获取订阅', color: '#10b981' };
    }

    const typeMap = {
        'Admin_Login': { text: '登录后台', color: '#f59e0b' },
        'Save_Config': { text: '保存配置', color: '#8b5cf6' },
        'Init_Config': { text: '重置配置', color: '#ef4444' },
        'Save_Custom_IPs': { text: '自定义优选', color: '#06b6d4' }
    };
    return typeMap[type] || { text: type, color: '#6b7280' };
}

// 格式化时间戳为 UTC+8
function formatTime(timestamp) {
    const date = new Date(timestamp + 8 * 3600 * 1000);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// 在展开日志模块时加载日志
let logsLoaded = false;
function loadLogsOnExpand(titleEl) {
    const module = titleEl.parentElement;
    const isCollapsed = module.classList.contains('collapsed');

    // 如果是展开状态且还未加载过日志，则加载
    if (!isCollapsed && !logsLoaded) {
        loadLogs();
    }
}

// 加载最近8条日志
async function loadLogs() {
    try {
        const response = await fetch('/admin/log.json?_t=' + Date.now(), {
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        });
        if (!response.ok) throw new Error('加载日志失败');
        const logs = await response.json();
        logsLoaded = true;

        // 按时间从新到旧排序，取前6条
        const recentLogs = logs.sort((a, b) => b.TIME - a.TIME).slice(0, 6);

        const container = document.getElementById('logsContainer');
        if (recentLogs.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 20px; color: #6b7280;">暂无日志记录</div>';
            return;
        }

        // 检查是否为移动设备
        const isMobile = window.innerWidth <= 768;

        let html = '<table style="width: 100%; border-collapse: collapse;">';
        if (isMobile) {
            // 移动设备：显示时间、IP、操作
            html += '<thead><tr style="border-bottom: 2px solid #e5e7eb;"><th style="text-align: left; padding: 10px; font-weight: 600;">时间 (UTC+8)</th><th style="text-align: left; padding: 10px; font-weight: 600;">IP</th><th style="text-align: left; padding: 10px; font-weight: 600;">操作</th></tr></thead>';
        } else {
            // 桌面设备：显示时间、IP、地区、操作
            html += '<thead><tr style="border-bottom: 2px solid #e5e7eb;"><th style="text-align: left; padding: 10px; font-weight: 600;">时间 (UTC+8)</th><th style="text-align: left; padding: 10px; font-weight: 600;">IP</th><th style="text-align: left; padding: 10px; font-weight: 600;">地区</th><th style="text-align: left; padding: 10px; font-weight: 600;">操作</th></tr></thead>';
        }
        html += '<tbody>';

        recentLogs.forEach(log => {
            const logType = translateLogType(log.TYPE, log.UA);
            const cc = log.CC || '未知';
            const timeStr = formatTime(log.TIME);
            const ip = log.IP || '未知';

            if (isMobile) {
                // 移动设备：不显示地区
                html += `<tr style="border-bottom: 1px solid #f3f4f6;"><td style="padding: 10px; font-size: 12px;">${timeStr}</td><td style="padding: 10px; font-family: monospace; font-size: 12px;">${ip}</td><td style="padding: 10px;"><span style="display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 12px; color: #fff; background-color: ${logType.color};">${logType.text}</span></td></tr>`;
            } else {
                // 桌面设备：显示地区
                html += `<tr style="border-bottom: 1px solid #f3f4f6;"><td style="padding: 10px;">${timeStr}</td><td style="padding: 10px; font-family: monospace; font-size: 12px;">${ip}</td><td style="padding: 10px;">${cc}</td><td style="padding: 10px;"><span style="display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 12px; color: #fff; background-color: ${logType.color};">${logType.text}</span></td></tr>`;
            }
        });

        html += '</tbody></table>';
        container.innerHTML = html;
    } catch (error) {
        const container = document.getElementById('logsContainer');
        container.innerHTML = `<div style="text-align: center; padding: 20px; color: #ef4444;">加载日志失败: ${error.message}</div>`;
    }
}

// 显示全部日志
async function showAllLogs() {
    try {
        const response = await fetch('/admin/log.json?_t=' + Date.now(), {
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        });
        if (!response.ok) throw new Error('加载日志失败');
        const logs = await response.json();

        // 按时间从新到旧排序
        const sortedLogs = logs.sort((a, b) => b.TIME - a.TIME);

        const container = document.getElementById('allLogsContainer');
        let html = '<table style="width: 100%; border-collapse: collapse; font-size: 12px; table-layout: auto;">';
        html += '<thead><tr style="border-bottom: 2px solid #e5e7eb; background: #f9fafb; white-space: nowrap;"><th style="text-align: left; padding: 10px; font-weight: 600; width: 160px;">时间 (UTC+8)</th><th style="text-align: left; padding: 10px; font-weight: 600; width: 120px;">IP</th><th style="text-align: left; padding: 10px; font-weight: 600; width: 80px;">地区</th><th style="text-align: left; padding: 10px; font-weight: 600; width: 80px;">ASN</th><th style="text-align: left; padding: 10px; font-weight: 600; width: 150px;">操作</th><th style="text-align: left; padding: 10px; font-weight: 600; flex: 1; min-width: 300px;">URL</th><th style="text-align: left; padding: 10px; font-weight: 600; flex: 1; min-width: 200px;">UA</th></tr></thead>';
        html += '<tbody>';

        sortedLogs.forEach(log => {
            const logType = translateLogType(log.TYPE, log.UA);
            const cc = log.CC || '未知';
            const asn = log.ASN || '未知';
            const timeStr = formatTime(log.TIME);
            const ip = log.IP || '未知';
            const url = log.URL || '无';
            const ua = log.UA ? log.UA.substring(0, 60) : '无';

            html += `<tr style="border-bottom: 1px solid #f3f4f6;"><td style="text-align: left; padding: 8px; white-space: nowrap; width: 160px; font-size: 11px;">${timeStr}</td><td style="text-align: left; padding: 8px; font-family: monospace; font-size: 10px; white-space: nowrap; width: 120px; word-break: break-word;">${ip}</td><td style="text-align: left; padding: 8px; white-space: nowrap; width: 80px; font-size: 11px;">${cc}</td><td style="text-align: left; padding: 8px; white-space: nowrap; width: 80px; font-size: 11px; font-family: monospace;">${asn}</td><td style="text-align: left; padding: 8px; width: 150px;"><span style="display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 11px; color: #fff; background-color: ${logType.color}; white-space: nowrap;">${logType.text}</span></td><td style="text-align: left; padding: 8px; font-size: 11px; word-break: break-word; min-width: 300px;">${url}</td><td style="text-align: left; padding: 8px; font-size: 10px; color: #6b7280; min-width: 200px; word-break: break-word;">${ua}</td></tr>`;
        });

        html += '</tbody></table>';
        container.innerHTML = html;
        document.getElementById('logsModal').classList.add('show');
    } catch (error) {
        showToast('加载日志失败: ' + error.message, 'error');
    }
}

// 关闭日志模态框
function closeLogsModal(event) {
    if (event && event.target.id !== 'logsModal') return;
    document.getElementById('logsModal').classList.remove('show');
}

// ==================== 代理验证模态框函数 ====================

// 全局变量存储当前验证的代理类型
let currentProxyType = null;
let currentProxyFieldId = null;

function openProxyVerificationModal(proxyType) {
    currentProxyType = proxyType;
    currentProxyFieldId = proxyType === 'socks5' ? 'socks5Addr' : (proxyType === 'https' ? 'httpsAddr' : 'httpAddr');

    // 设置模态框标题和标签
    const title = proxyType === 'socks5' ? '🔒 SOCKS5代理验证' : (proxyType === 'https' ? '🌐 HTTPS代理验证' : '🌐 HTTP代理验证');
    const label = proxyType === 'socks5' ? 'SOCKS5代理:' : (proxyType === 'https' ? 'HTTPS代理:' : 'HTTP代理:');

    document.getElementById('proxyVerificationTitle').textContent = title;
    document.getElementById('proxyVerificationLabel').textContent = label;
    document.getElementById('proxyVerificationInput').placeholder = proxyType === 'socks5'
        ? 'user:password@127.0.0.1:1080'
        : (proxyType === 'https' ? 'user:password@127.0.0.1:8443' : 'user:password@127.0.0.1:8080');

    // 设置输入框的当前值
    const currentValue = document.getElementById(currentProxyFieldId).value;
    document.getElementById('proxyVerificationInput').value = currentValue;

    // 重置状态
    document.getElementById('proxyVerificationStatus').style.display = 'none';
    document.getElementById('proxyVerificationStatus').textContent = '';
    document.getElementById('proxyConfirmBtn').disabled = true;
    document.getElementById('proxyConfirmBtn').style.opacity = '0.5';

    // 显示模态框
    document.getElementById('proxyVerificationModal').classList.add('show');
}

function closeProxyVerificationModal(event) {
    document.getElementById('proxyVerificationModal').classList.remove('show');
    currentProxyType = null;
    currentProxyFieldId = null;
    document.getElementById('proxyVerificationInput').value = '';
    document.getElementById('proxyVerificationStatus').style.display = 'none';
}

async function verifyProxyAvailability() {
    const input = document.getElementById('proxyVerificationInput').value.trim();
    if (!input) {
        showProxyVerificationStatus('请输入代理地址', 'error');
        return;
    }

    // 预处理代理地址
    const processedAddress = processProxyAddressForValidation(input, currentProxyType);
    if (!processedAddress) {
        showProxyVerificationStatus('代理地址格式无效', 'error');
        return;
    }

    const statusEl = document.getElementById('proxyVerificationStatus');
    const verifyBtn = document.querySelector('#proxyVerificationModal .btn-verify-api');

    try {
        verifyBtn.disabled = true;
        statusEl.textContent = '⏳ 验证中...';
        statusEl.style.display = 'block';
        statusEl.style.background = 'linear-gradient(135deg, #3b82f6 0, #1d4ed8 100%)';
        statusEl.style.color = '#fff';
        statusEl.style.padding = '16px';
        statusEl.style.borderRadius = '8px';

        // 构建请求参数
        const params = new URLSearchParams();
        if (currentProxyType === 'socks5') {
            params.append('socks5', processedAddress);
        } else if (currentProxyType === 'https') {
            params.append('https', processedAddress);
        } else {
            params.append('http', processedAddress);
        }

        // 创建 AbortController 实现 5 秒超时
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);

        const response = await fetch(`/admin/check?${params}&_t=${Date.now()}`, {
            method: 'GET',
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const data = await response.json();

        // 检查是否有 success 字段
        if (!data.hasOwnProperty('success')) {
            statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
            statusEl.style.padding = '16px';
            statusEl.style.borderRadius = '8px';
            statusEl.innerHTML = '❌ <strong>后端版本过旧</strong><br/><small style="opacity: 0.9;">请升级 edgetunnel 代码</small>';
            document.getElementById('proxyConfirmBtn').disabled = true;
            document.getElementById('proxyConfirmBtn').style.opacity = '0.5';
        } else if (data.success === false) {
            statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
            statusEl.style.padding = '16px';
            statusEl.style.borderRadius = '8px';
            statusEl.innerHTML = `❌ <strong>代理无效</strong><br/><small style="opacity: 0.9;">${data.error || '未知错误'}</small>`;
            document.getElementById('proxyConfirmBtn').disabled = true;
            document.getElementById('proxyConfirmBtn').style.opacity = '0.5';
        } else if (data.success === true) {
            const ip = data.ip || '未知';
            const loc = data.loc || '未知';
            const responseTime = data.responseTime || 0;
            const responseTimeDisplay = responseTime > 0 ? `${responseTime}ms` : '未知';

            statusEl.style.background = 'linear-gradient(135deg, #10b981 0, #059669 100%)';
            statusEl.style.padding = '16px';
            statusEl.style.borderRadius = '8px';
            statusEl.innerHTML = `
                <div style="display: flex; flex-direction: column; gap: 10px; font-family: 'Inter', system-ui, sans-serif;">
                    <!-- 顶部标题栏 -->
                    <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.15); padding-bottom: 8px; margin-bottom: 2px;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <div style="width: 8px; height: 8px; background: #fff; border-radius: 50%; box-shadow: 0 0 8px #fff; animation: pulse 2s infinite;"></div>
                            <span style="font-weight: 700; font-size: 12px; letter-spacing: 0.05em; text-transform: uppercase; color: #fff;">Connection Secured</span>
                        </div>
                        <span style="font-size: 10px; opacity: 0.7; font-family: 'Fira Code', monospace; color: #fff;">STATUS: 200 OK</span>
                    </div>
                    
                    <!-- 信息网格 -->
                    <div style="display: grid; grid-template-columns: 0.4fr 1.2fr; gap: 8px;">
                        <div style="background: rgba(0,0,0,0.15); padding: 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); min-width: 0; max-width: 100px;">
                            <div style="font-size: 10px; opacity: 0.7; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; color: #fff;">区域 (Region)</div>
                            <div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff;" title="${loc}">${loc}</div>
                        </div>
                        <div style="background: rgba(0,0,0,0.15); padding: 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); min-width: 0;">
                            <div style="font-size: 10px; opacity: 0.7; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; color: #fff; text-align: center;">落地地址 (IP)</div>
                            <div style="font-family: 'Fira Code', monospace; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px; color: #fff; text-decoration: underline; min-width: 0;" onclick="showIpDetailForProxy('${ip}', this)">
                                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${ip}">${ip}</span>
                                <span style="font-size: 12px; opacity: 0.8; flex-shrink: 0;">🔍</span>
                            </div>
                        </div>
                    </div>
                    
                    <!-- 底部延迟栏 -->
                    <div style="background: rgba(255,255,255,0.1); padding: 8px 12px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; border-left: 3px solid #fff;">
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span style="font-size: 14px;">⏱️</span>
                            <span style="font-size: 11px; font-weight: 500; opacity: 0.9; color: #fff;">响应延迟</span>
                        </div>
                        <div style="font-family: 'Orbitron', sans-serif; font-size: 16px; font-weight: 800; color: #fff; text-shadow: 0 0 10px rgba(255,255,255,0.3);">
                            ${responseTimeDisplay}
                        </div>
                    </div>
                </div>
            `;

            // 启用确定按钮
            document.getElementById('proxyConfirmBtn').disabled = false;
            document.getElementById('proxyConfirmBtn').style.opacity = '1';

            // 存储验证后的地址以备后用
            document.getElementById('proxyConfirmBtn').dataset.validAddress = processedAddress;
        }
    } catch (error) {
        statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
        statusEl.style.padding = '16px';
        statusEl.style.borderRadius = '8px';

        // 判断是否为超时错误
        if (error.name === 'AbortError') {
            statusEl.innerHTML = `❌ <strong>验证超时</strong><br/><small style="opacity: 0.9;">请求超过 10 秒无响应，请检查代理连接</small>`;
        } else {
            statusEl.innerHTML = `❌ <strong>验证失败</strong><br/><small style="opacity: 0.9;">${error.message}</small>`;
        }

        document.getElementById('proxyConfirmBtn').disabled = true;
        document.getElementById('proxyConfirmBtn').style.opacity = '0.5';
    } finally {
        verifyBtn.disabled = false;
    }
}

function processProxyAddressForValidation(input, type) {
    input = input.trim();

    // 移除开头的 "/" 或 "/"
    if (input.startsWith('/')) {
        input = input.substring(1).trim();
    }

    // 检测并移除协议前缀
    const socks5Prefixes = ['socks5://', 'socks5=', 'socks5://'];
    const httpPrefixes = ['http://', 'http='];
    const httpsPrefixes = ['https://', 'https='];

    for (const prefix of socks5Prefixes) {
        if (input.toLowerCase().startsWith(prefix)) {
            input = input.substring(prefix.length).trim();
            break;
        }
    }

    for (const prefix of httpPrefixes) {
        if (input.toLowerCase().startsWith(prefix)) {
            input = input.substring(prefix.length).trim();
            break;
        }
    }

    for (const prefix of httpsPrefixes) {
        if (input.toLowerCase().startsWith(prefix)) {
            input = input.substring(prefix.length).trim();
            break;
        }
    }

    // 移除末尾的备注（#符号之后的内容）
    if (input.includes('#')) {
        input = input.split('#')[0].trim();
    }

    return input;
}

function showProxyVerificationStatus(message, type) {
    const statusEl = document.getElementById('proxyVerificationStatus');
    const prefix = type === 'error' ? '❌' : 'ℹ️';
    statusEl.textContent = prefix + ' ' + message;
    statusEl.style.display = 'block';
    if (type === 'error') {
        statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
    } else {
        statusEl.style.background = 'linear-gradient(135deg, #3b82f6 0, #1d4ed8 100%)';
    }
    statusEl.style.color = '#fff';
}

async function fetchAndShowIpDetail(ip, targetElement = null) {
    let cleanIp = String(ip || '').trim();
    if (cleanIp.includes('*') && targetElement && targetElement.dataset && targetElement.dataset.rawValue) {
        cleanIp = String(targetElement.dataset.rawValue || '').trim();
    }
    if (!cleanIp || cleanIp === '未知') {
        return;
    }

    if (targetElement) {
        if (targetElement.classList.contains('is-loading')) {
            return; // 正在加载中,不重复请求
        }
        targetElement.classList.add('is-loading');
        targetElement.setAttribute('aria-busy', 'true');
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒超时

        let response;
        try {
            response = await fetch(`https://api.ipapi.is/?q=${cleanIp}`, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error('Primary API failed');
        } catch (e) {
            console.warn('Primary IP API failed, trying fallback...', e);
            response = await fetch(`https://api.090227.xyz/api/ipapi?ip=${cleanIp}`);
            if (!response.ok) throw new Error('Fallback API failed');
        }

        const data = await response.json();

        // 显示详情弹窗
        showIpDetailModal(data);
    } catch (error) {
        showToast('❌ 查询IP详细信息失败');
        console.error('IP查询错误:', error);
    } finally {
        if (targetElement) {
            targetElement.classList.remove('is-loading');
            targetElement.removeAttribute('aria-busy');
        }
    }
}

async function showIpDetailForProxy(ip, element = null) {
    fetchAndShowIpDetail(ip, element);
}

function confirmProxyAddress() {
    const validAddress = document.getElementById('proxyConfirmBtn').dataset.validAddress;
    if (!validAddress) return;

    document.getElementById(currentProxyFieldId).value = validAddress;
    markModified('proxy');
    closeProxyVerificationModal();
}

function openSubAPIModal() {
    const currentValue = document.getElementById('subAPI').value;
    document.getElementById('subAPIStatus').style.display = 'none';
    document.getElementById('subAPIStatus').textContent = '';
    document.getElementById('subAPIConfirmBtn').disabled = true;
    document.getElementById('subAPIConfirmBtn').style.opacity = '0.5';
    document.getElementById('subAPIModal').classList.add('show');

    // 加载 SUBAPI 列表
    loadSubAPIList(currentValue);
}

function closeSubAPIModal(event) {
    if (event && event.target.id !== 'subAPIModal') return;
    document.getElementById('subAPIModal').classList.remove('show');
    document.getElementById('testSubAPIInput').value = '';
    document.getElementById('subAPIStatus').style.display = 'none';
}

async function loadSubAPIList(currentValue) {
    const selectEl = document.getElementById('subAPISelect');
    selectEl.innerHTML = '<option value="">-- 加载中，请稍候 --</option>';

    try {
        const jsonText = await fetchWithAutoMirror(
            'https://raw.githubusercontent.com/cmliu/cmliu/main/SUBAPI.json',
            'SUBAPI 列表'
        );

        const apiList = JSON.parse(jsonText);

        // 清空选项
        selectEl.innerHTML = '';

        // 添加 API 列表的选项
        apiList.forEach(item => {
            const option = document.createElement('option');
            option.value = item.value;
            option.textContent = `${item.label}[${item.value}]`;
            selectEl.appendChild(option);
        });

        // 添加自定义选项
        const customOption = document.createElement('option');
        customOption.value = 'custom';
        customOption.textContent = '🔧 自定义';
        selectEl.appendChild(customOption);

        // 尝试匹配当前值（大小写不敏感比较）
        if (currentValue && currentValue.trim()) {
            const currentValueLower = currentValue.trim().toLowerCase();
            const matchedOption = Array.from(selectEl.options).find(
                opt => opt.value.toLowerCase() === currentValueLower
            );
            if (matchedOption) {
                // 找到了匹配的选项
                selectEl.value = matchedOption.value;
                document.getElementById('customSubAPIInputGroup').style.display = 'none';
                document.getElementById('testSubAPIInput').value = '';
            } else {
                // 没有找到匹配的选项，说明是自定义的
                selectEl.value = 'custom';
                document.getElementById('testSubAPIInput').value = currentValue.trim();
                document.getElementById('customSubAPIInputGroup').style.display = 'block';
            }
        } else {
            // 没有当前值，显示第一个选项
            selectEl.value = '';
            document.getElementById('customSubAPIInputGroup').style.display = 'none';
            document.getElementById('testSubAPIInput').value = '';
        }
    } catch (error) {
        console.error('加载 SUBAPI 列表失败:', error);
        selectEl.innerHTML = '<option value="custom">🔧 自定义</option>';
        selectEl.value = 'custom';
        document.getElementById('customSubAPIInputGroup').style.display = 'block';
        if (currentValue && currentValue.trim()) {
            document.getElementById('testSubAPIInput').value = currentValue.trim();
        } else {
            document.getElementById('testSubAPIInput').value = '';
        }
    }
}

function handleSubAPISelectChange() {
    const selectEl = document.getElementById('subAPISelect');
    const customInputGroup = document.getElementById('customSubAPIInputGroup');
    const testInput = document.getElementById('testSubAPIInput');

    if (selectEl.value === 'custom') {
        customInputGroup.style.display = 'block';
        testInput.focus();
    } else {
        customInputGroup.style.display = 'none';
        testInput.value = selectEl.value;
    }
}

// ProxyIP 帮助模态框函数
function showProxyIPHelpModal() {
    document.getElementById('proxyIPHelpModal').classList.add('show');
}

function closeProxyIPHelpModal(event) {
    if (event && event.target.id !== 'proxyIPHelpModal') return;
    document.getElementById('proxyIPHelpModal').classList.remove('show');
}

// 路径模板配置函数
let pathTemplatePresets = [];
let pathTemplateOriginal = {};

async function showPathTemplateConfigModal() {
    const modal = document.getElementById('pathTemplateConfigModal');
    modal.classList.add('show');

    // 初始化原始值
    pathTemplateOriginal = JSON.parse(JSON.stringify(currentConfig.反代?.路径模板 || {}));

    // 加载预设模板
    await loadPathTemplatePresets();

    // 填充当前配置到文本框（添加"/"前缀用于显示）
    document.getElementById('proxyIPTemplateInput').value = '/' + (currentConfig.反代?.路径模板?.PROXYIP || '');
    document.getElementById('socks5StandardTemplateInput').value = '/' + (currentConfig.反代?.路径模板?.SOCKS5?.标准 || '');
    document.getElementById('socks5GlobalTemplateInput').value = '/' + (currentConfig.反代?.路径模板?.SOCKS5?.全局 || '');
    document.getElementById('httpStandardTemplateInput').value = '/' + (currentConfig.反代?.路径模板?.HTTP?.标准 || '');
    document.getElementById('httpGlobalTemplateInput').value = '/' + (currentConfig.反代?.路径模板?.HTTP?.全局 || '');

    // 初始化验证状态
    validatePathTemplate('proxyIPTemplateInput', currentConfig.反代?.路径模板?.PROXYIP || '');
    validatePathTemplate('socks5StandardTemplateInput', currentConfig.反代?.路径模板?.SOCKS5?.标准 || '');
    validatePathTemplate('socks5GlobalTemplateInput', currentConfig.反代?.路径模板?.SOCKS5?.全局 || '');
    validatePathTemplate('httpStandardTemplateInput', currentConfig.反代?.路径模板?.HTTP?.标准 || '');
    validatePathTemplate('httpGlobalTemplateInput', currentConfig.反代?.路径模板?.HTTP?.全局 || '');

    // 禁用保存按钮
    document.getElementById('pathTemplateSaveBtn').disabled = true;

    // 重置预设模板选择
    document.getElementById('presetTemplateSelect').value = 'custom';
}

function closePathTemplateConfigModal(event) {
    if (event && event.target.id !== 'pathTemplateConfigModal') return;
    document.getElementById('pathTemplateConfigModal').classList.remove('show');
}

async function loadPathTemplatePresets() {
    try {
        const url = 'https://raw.githubusercontent.com/cmliu/cmliu/main/json/edt-path-config.json';
        const text = await fetchWithAutoMirror(url, '路径模板配置');
        pathTemplatePresets = JSON.parse(text);

        const select = document.getElementById('presetTemplateSelect');
        // 清除除"自定义"外的所有选项
        while (select.options.length > 1) {
            select.remove(1);
        }

        // 添加预设模板选项
        pathTemplatePresets.forEach(preset => {
            const option = document.createElement('option');
            option.value = preset.项目名;
            option.textContent = preset.项目名;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('加载路径模板预设失败:', error);
        showToast('加载预设模板失败: ' + error.message, 'error');
    }
}

function onPresetTemplateChange() {
    const select = document.getElementById('presetTemplateSelect');
    const selectedValue = select.value;

    if (selectedValue === 'custom') {
        return;
    }

    // 找到对应的预设
    const preset = pathTemplatePresets.find(p => p.项目名 === selectedValue);
    if (!preset) return;

    // 显示提示消息
    showToast(preset.提示消息, 'info');

    // 填充模板（添加"/"前缀用于显示）
    document.getElementById('proxyIPTemplateInput').value = '/' + (preset.路径模板.PROXYIP || '');
    document.getElementById('socks5StandardTemplateInput').value = '/' + (preset.路径模板.SOCKS5.标准 || '');
    document.getElementById('socks5GlobalTemplateInput').value = '/' + (preset.路径模板.SOCKS5.全局 || '');
    document.getElementById('httpStandardTemplateInput').value = '/' + (preset.路径模板.HTTP.标准 || '');
    document.getElementById('httpGlobalTemplateInput').value = '/' + (preset.路径模板.HTTP.全局 || '');

    // 验证填充后的内容
    validatePathTemplate('proxyIPTemplateInput', preset.路径模板.PROXYIP || '');
    validatePathTemplate('socks5StandardTemplateInput', preset.路径模板.SOCKS5.标准 || '');
    validatePathTemplate('socks5GlobalTemplateInput', preset.路径模板.SOCKS5.全局 || '');
    validatePathTemplate('httpStandardTemplateInput', preset.路径模板.HTTP.标准 || '');
    validatePathTemplate('httpGlobalTemplateInput', preset.路径模板.HTTP.全局 || '');

    // 亮起保存按钮
    document.getElementById('pathTemplateSaveBtn').disabled = false;
}

function onPathTemplateInput() {
    // 获取所有模板输入框的值（去掉开头的"/"用于对比）
    const proxyIP = document.getElementById('proxyIPTemplateInput').value.replace(/^\//, '');
    const socks5Standard = document.getElementById('socks5StandardTemplateInput').value.replace(/^\//, '');
    const socks5Global = document.getElementById('socks5GlobalTemplateInput').value.replace(/^\//, '');
    const httpStandard = document.getElementById('httpStandardTemplateInput').value.replace(/^\//, '');
    const httpGlobal = document.getElementById('httpGlobalTemplateInput').value.replace(/^\//, '');

    // 验证每个输入框是否包含占位符，没有则标记为invalid
    validatePathTemplate('proxyIPTemplateInput', proxyIP);
    validatePathTemplate('socks5StandardTemplateInput', socks5Standard);
    validatePathTemplate('socks5GlobalTemplateInput', socks5Global);
    validatePathTemplate('httpStandardTemplateInput', httpStandard);
    validatePathTemplate('httpGlobalTemplateInput', httpGlobal);

    // 检查是否有任何内容发生变化
    const hasChanged =
        proxyIP !== (pathTemplateOriginal.PROXYIP || '') ||
        socks5Standard !== (pathTemplateOriginal.SOCKS5?.标准 || '') ||
        socks5Global !== (pathTemplateOriginal.SOCKS5?.全局 || '') ||
        httpStandard !== (pathTemplateOriginal.HTTP?.标准 || '') ||
        httpGlobal !== (pathTemplateOriginal.HTTP?.全局 || '');

    // 控制保存按钮的启用/禁用
    document.getElementById('pathTemplateSaveBtn').disabled = !hasChanged;
}

function validatePathTemplate(inputId, value) {
    const inputElement = document.getElementById(inputId);
    const wrapper = inputElement.closest('.path-template-input-wrapper');

    // 生成对应的错误提示的ID
    const errorId = inputId.replace('Input', 'Error');
    const errorElement = document.getElementById(errorId);

    // 如果内容不为空且不包含占位符，添加invalid样式并显示错误提示
    if (value.trim() && !value.includes('{{IP:PORT}}')) {
        wrapper.classList.add('invalid');
        if (errorElement) {
            errorElement.style.display = 'block';
        }
    } else {
        wrapper.classList.remove('invalid');
        if (errorElement) {
            errorElement.style.display = 'none';
        }
    }
}

async function savePathTemplateConfig() {
    // 获取输入框的值并去掉开头的"/"
    const proxyIP = document.getElementById('proxyIPTemplateInput').value.replace(/^\//, '');
    const socks5Standard = document.getElementById('socks5StandardTemplateInput').value.replace(/^\//, '');
    const socks5Global = document.getElementById('socks5GlobalTemplateInput').value.replace(/^\//, '');
    const httpStandard = document.getElementById('httpStandardTemplateInput').value.replace(/^\//, '');
    const httpGlobal = document.getElementById('httpGlobalTemplateInput').value.replace(/^\//, '');

    try {
        // 验证是否包含{{IP:PORT}}占位符
        const templates = [proxyIP, socks5Standard, socks5Global, httpStandard, httpGlobal].filter(t => t);
        if (templates.length > 0) {
            const hasPlaceholder = templates.every(t => t.includes('{{IP:PORT}}'));
            if (!hasPlaceholder) {
                showToast('当前路径模板存在缺失 {{IP:PORT}} 占位符', 'error');
                //return;
            }
        }

        // 更新currentConfig中的路径模板数据（不包含开头的"/"）
        if (!currentConfig.反代) {
            currentConfig.反代 = {};
        }
        if (!currentConfig.反代.路径模板) {
            currentConfig.反代.路径模板 = {};
        }

        currentConfig.反代.路径模板.PROXYIP = proxyIP;
        currentConfig.反代.路径模板.SOCKS5 = {
            标准: socks5Standard,
            全局: socks5Global
        };
        currentConfig.反代.路径模板.HTTP = {
            标准: httpStandard,
            全局: httpGlobal
        };

        // 通过saveConfigToServer保存到服务器
        await saveConfigToServer('pathTemplate');

        // 关闭模态框
        closePathTemplateConfigModal();
    } catch (error) {
        console.error('保存路径模板失败:', error);
        showToast('保存路径模板失败: ' + error.message, 'error');
    }
}

function toggleProxyIPHelpMode() {
    const checkbox = document.getElementById('proxyIPSimpleMode');
    const simpleDiv = document.getElementById('proxyIPHelpSimple');
    const detailDiv = document.getElementById('proxyIPHelpDetail');

    if (checkbox.checked) {
        // 显示简易模式
        simpleDiv.style.display = 'block';
        detailDiv.style.display = 'none';
    } else {
        // 显示详细模式
        simpleDiv.style.display = 'none';
        detailDiv.style.display = 'block';
    }
}

// 防止输出"#"字符，允许输入"?"
function preventInvalidChars(input) {
    input.value = input.value.replace(/#/g, '');
}

function preventInvalidCharsOnKeypress(event) {
    if (event.key === '#') {
        event.preventDefault();
    }
}

// 确保路径以"/"开头（虽然显示中已有前缀，但防止意外删除）
function ensurePathPrefix(input) {
    // 不在这里强制，而是在防删除函数中处理
}

// 防止删除路径前缀"/"
function preventPathPrefixDeletion(event, input) {
    // 只在删除键时处理
    if (event.key === 'Backspace' || event.key === 'Delete') {
        // 如果选中的文本包括位置0（开头），阻止删除
        if (input.selectionStart === 0 && event.key === 'Backspace') {
            event.preventDefault();
            return false;
        }
        // 如果光标在开头且按下Delete，防止删除
        if (input.selectionStart === 0 && event.key === 'Delete') {
            event.preventDefault();
            return false;
        }
    }
    // 防止在开头输入任何内容
    if (input.selectionStart === 0 && event.key && event.key.length === 1 && event.key !== '/') {
        // 将光标移动到位置1
        setTimeout(() => {
            input.setSelectionRange(1, 1);
        }, 0);
    }
}

// ECH 帮助模态框函数
function showECHHelpModal() {
    document.getElementById('echHelpModal').classList.add('show');

    // 计算并设置内容高度以适应浏览器高度
    setTimeout(() => {
        calculateECHContentHeight();
        // 窗口大小改变时重新计算
        window.addEventListener('resize', calculateECHContentHeight);
    }, 0);
}

function calculateECHContentHeight() {
    const modal = document.querySelector('.ech-help-modal');
    const tabContent = document.querySelector('.ech-tab-content');
    const tabs = document.querySelector('.ech-tabs');
    const closeBtn = document.querySelector('#echHelpModal .modal-close');
    const bottomBtn = document.querySelector('#echHelpModal .btn-close-modal');

    if (!modal || !tabContent) return;

    // 获取浏览器视口高度
    const viewportHeight = window.innerHeight;

    // 计算各个元素的高度（带上下文margin/padding）
    const modalPadding = 20; // 模态框内边距
    const tabsHeight = tabs ? tabs.offsetHeight + 15 : 50; // 选项卡高度 + margin
    const closeBtnHeight = 40; // 关闭按钮高度
    const bottomBtnHeight = bottomBtn ? bottomBtn.offsetHeight + 20 : 60; // 底部按钮高度 + margin
    const headerHeight = 20; // 其他上边距

    // 计算可用的内容高度
    // viewportHeight - (顶部padding + 选项卡 + 底部按钮 + 底部padding)
    const availableHeight = viewportHeight - (modalPadding * 2 + tabsHeight + bottomBtnHeight + headerHeight);

    // 设置最大高度，确保不超出视口
    tabContent.style.maxHeight = Math.max(200, availableHeight) + 'px';
}

function closeECHHelpModal(event) {
    if (event && event.target.id !== 'echHelpModal') return;
    document.getElementById('echHelpModal').classList.remove('show');
}

function switchECHTab(tabIndex) {
    // 切换选项卡按钮状态
    const tabs = document.querySelectorAll('.ech-tab');
    tabs.forEach((tab, index) => {
        if (index === tabIndex) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    // 切换选项卡内容
    const panes = document.querySelectorAll('.ech-tab-pane');
    panes.forEach((pane, index) => {
        if (index === tabIndex) {
            pane.classList.add('active');
        } else {
            pane.classList.remove('active');
        }
    });

    // 自动滚动到活跃选项卡
    const activeTab = tabs[tabIndex];
    if (activeTab) {
        const tabsContainer = document.querySelector('.ech-tabs');
        if (tabsContainer) {
            activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }
}

// ECH 选项卡拖拽功能
function initECHTabsDrag() {
    const tabsContainer = document.querySelector('.ech-tabs');
    if (!tabsContainer) return;

    let isDown = false;
    let startX;
    let scrollLeft;
    let isDragged = false;

    tabsContainer.addEventListener('mousedown', (e) => {
        // 如果点击的是按钮，不启动拖拽
        if (e.target.closest('.ech-tab')) {
            isDown = true;
            isDragged = false;
            startX = e.pageX - tabsContainer.offsetLeft;
            scrollLeft = tabsContainer.scrollLeft;
            tabsContainer.classList.add('dragging');
        }
    });

    tabsContainer.addEventListener('mouseleave', () => {
        isDown = false;
        tabsContainer.classList.remove('dragging');
    });

    tabsContainer.addEventListener('mouseup', () => {
        isDown = false;
        tabsContainer.classList.remove('dragging');
    });

    tabsContainer.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();

        const x = e.pageX - tabsContainer.offsetLeft;
        const walk = (x - startX) * 1; // 拖拽速度

        if (Math.abs(walk) > 5) {
            isDragged = true;
        }

        tabsContainer.scrollLeft = scrollLeft - walk;
    });

    // 触摸设备支持
    tabsContainer.addEventListener('touchstart', (e) => {
        isDown = true;
        isDragged = false;
        startX = e.touches[0].pageX - tabsContainer.offsetLeft;
        scrollLeft = tabsContainer.scrollLeft;
    });

    tabsContainer.addEventListener('touchend', () => {
        isDown = false;
    });

    tabsContainer.addEventListener('touchmove', (e) => {
        if (!isDown) return;

        const x = e.touches[0].pageX - tabsContainer.offsetLeft;
        const walk = (x - startX) * 1;

        if (Math.abs(walk) > 5) {
            isDragged = true;
        }

        tabsContainer.scrollLeft = scrollLeft - walk;
    });

    // 为选项卡按钮添加点击拦截，防止拖拽时误触发
    const tabs = document.querySelectorAll('.ech-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', (e) => {
            if (isDragged) {
                e.preventDefault();
                e.stopPropagation();
                isDragged = false;
            }
        });
    });
}

// 在模态框显示时初始化拖拽
const echHelpModalOriginal = showECHHelpModal;
showECHHelpModal = function () {
    echHelpModalOriginal.call(this);
    setTimeout(() => {
        initECHTabsDrag();
    }, 0);
}

function normalizeSubAPIURL(url) {
    url = url.trim();
    if (!url) return null;

    let parsedURL;

    if (!url.includes('://')) {
        url = 'https://' + url;
    }

    try {
        parsedURL = new URL(url);
    } catch (e) {
        return null;
    }

    const baseURL = parsedURL.origin;
    return baseURL;
}

async function testSubAPI() {
    let input;
    const selectEl = document.getElementById('subAPISelect');

    if (selectEl.value === 'custom' || !selectEl.value) {
        // 如果是自定义或未选择，从输入框获取
        input = document.getElementById('testSubAPIInput').value.trim();
    } else {
        // 否则从下拉框获取
        input = selectEl.value.trim();
        document.getElementById('testSubAPIInput').value = input;
    }

    if (!input) {
        showStatus('请输入地址', 'error');
        return;
    }

    const baseURL = normalizeSubAPIURL(input);
    if (!baseURL) {
        showStatus('地址格式无效', 'error');
        return;
    }

    const testURL = baseURL + '/version';
    const statusEl = document.getElementById('subAPIStatus');
    const buttons = document.querySelectorAll('#subAPIModal button.btn');
    const testBtn = buttons[0];

    try {
        testBtn.disabled = true;
        statusEl.textContent = '⏳ 检测中...';
        statusEl.style.display = 'block';
        statusEl.style.background = 'linear-gradient(135deg, #3b82f6 0, #1d4ed8 100%)';
        statusEl.style.color = '#fff';

        const response = await fetch(testURL, {
            method: 'GET'
        });

        if (response.status === 200) {
            const content = await response.text();
            const lowerContent = content.toLowerCase();

            if (lowerContent.includes('subconverter')) {
                statusEl.style.background = 'linear-gradient(135deg, #10b981 0, #059669 100%)';
                statusEl.textContent = '✅ ' + content;
                document.getElementById('subAPIConfirmBtn').disabled = false;
                document.getElementById('subAPIConfirmBtn').style.opacity = '1';
                document.getElementById('subAPIConfirmBtn').dataset.validURL = baseURL;
            } else {
                statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
                statusEl.textContent = '❌ 响应内容无效';
                document.getElementById('subAPIConfirmBtn').disabled = true;
                document.getElementById('subAPIConfirmBtn').style.opacity = '0.5';
            }
        } else {
            statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
            statusEl.textContent = '❌ 请求失败 (HTTP ' + response.status + ')';
            document.getElementById('subAPIConfirmBtn').disabled = true;
            document.getElementById('subAPIConfirmBtn').style.opacity = '0.5';
        }
    } catch (error) {
        statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
        statusEl.textContent = '❌ 检测失败: ' + error.message;
        document.getElementById('subAPIConfirmBtn').disabled = true;
        document.getElementById('subAPIConfirmBtn').style.opacity = '0.5';
    } finally {
        testBtn.disabled = false;
    }
}

function showStatus(message, type) {
    const statusEl = document.getElementById('subAPIStatus');
    const prefix = type === 'error' ? '❌' : 'ℹ️';
    statusEl.textContent = prefix + ' ' + message;
    statusEl.style.display = 'block';
    if (type === 'error') {
        statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
    } else {
        statusEl.style.background = 'linear-gradient(135deg, #3b82f6 0, #1d4ed8 100%)';
    }
    statusEl.style.color = '#fff';
}

function confirmSubAPI() {
    const validURL = document.getElementById('subAPIConfirmBtn').dataset.validURL;
    if (!validURL) return;

    document.getElementById('subAPI').value = validURL;
    markModified('convert');
    closeSubAPIModal();
}

// ==================== 消息通知设置相关函数 ====================

// 更新 Telegram 按钮状态和颜色
function updateTelegramButtonStates(isConfigured) {
    // 获取 Telegram 按钮元素（第一组通知按钮是 Telegram）
    const buttons = document.querySelectorAll('.notification-controls');

    if (buttons.length > 0) {
        const telegramControls = buttons[0];
        const configBtn = telegramControls.querySelector('.btn-notification-config');
        const clearBtn = telegramControls.querySelector('.btn-clear-config');

        if (isConfigured) {
            // 已配置：参数配置按钮为绿色，清除配置按钮为红色且可点击
            clearBtn.classList.remove('btn-not-configured');
            clearBtn.classList.add('btn-configured');
            clearBtn.disabled = false;
        } else {
            // 未配置：参数配置按钮保持绿色，清除配置按钮为灰色且禁用
            clearBtn.classList.remove('btn-configured');
            clearBtn.classList.add('btn-not-configured');
            clearBtn.disabled = true;
        }
    }
}

// 清除 Telegram 配置
async function clearTelegramConfig() {
    if (confirm('确定要清除 Telegram 配置吗？')) {
        currentConfig.TG = {
            BotToken: null,
            ChatID: null,
            启用: false
        };

        try {
            await saveConfigToServer('notification');
            showToast('Telegram 配置已清除', 'success');
            updateTelegramButtonStates(false);
            const telegramCheckbox = document.getElementById('telegramEnabled');
            telegramCheckbox.disabled = true;
            telegramCheckbox.checked = false;
        } catch (error) {
            showToast('清除配置失败: ' + error.message, 'error');
        }
    }
}

// 更新 Cloudflare 按钮状态和颜色
function updateCloudflareButtonStates(isConfigured) {
    // 获取 Cloudflare 按钮元素（第二组通知按钮是 Cloudflare）
    const buttons = document.querySelectorAll('.notification-controls');

    if (buttons.length > 1) {
        const cloudflareControls = buttons[1];
        const clearBtn = cloudflareControls.querySelector('.btn-clear-config');

        if (isConfigured) {
            // 已配置：清除配置按钮为红色且可点击
            clearBtn.classList.remove('btn-not-configured');
            clearBtn.classList.add('btn-configured');
            clearBtn.disabled = false;
        } else {
            // 未配置：清除配置按钮为灰色且禁用
            clearBtn.classList.remove('btn-configured');
            clearBtn.classList.add('btn-not-configured');
            clearBtn.disabled = true;
        }
    }
}

// 清除 Cloudflare 配置
async function clearCloudflareConfig() {
    if (confirm('确定要清除 Cloudflare 配置吗？')) {
        currentConfig.CF = {
            Usage: null,
            启用: false
        };

        try {
            await saveConfigToServer('notification');
            showToast('Cloudflare 配置已清除', 'success');
            updateCloudflareButtonStates(false);
        } catch (error) {
            showToast('清除配置失败: ' + error.message, 'error');
        }
    }
}

// 打开 TelegramBot 配置模态框
function openTelegramConfigModal() {
    document.getElementById('telegramConfigModal').classList.add('show');
    // 只加载Chat ID，不加载Bot Token（因为Bot Token是敏感信息）
    const chatID = currentConfig.TG?.ChatID || currentConfig.通知?.Telegram?.ChatID || '';
    document.getElementById('telegramBotToken').value = '';
    document.getElementById('telegramChatID').value = chatID;

    // 重置状态和保存按钮
    document.getElementById('telegramStatus').style.display = 'none';
    document.getElementById('telegramStatus').textContent = '';
    document.getElementById('telegramConfirmBtn').disabled = true;
    document.getElementById('telegramConfirmBtn').style.opacity = '0.5';
}

// 关闭 TelegramBot 配置模态框
function closeTelegramConfigModal(event) {
    if (event && event.target.id !== 'telegramConfigModal') return;
    document.getElementById('telegramConfigModal').classList.remove('show');
}

// 测试 TelegramBot 连接
async function testTelegramConfig() {
    const token = document.getElementById('telegramBotToken').value.trim();
    const chatID = document.getElementById('telegramChatID').value.trim();
    const statusEl = document.getElementById('telegramStatus');
    const confirmBtn = document.getElementById('telegramConfirmBtn');
    const testBtn = event.target;
    const telegramApiBases = [
        'https://api.telegram.org',
        'https://api.tg.090227.xyz'
    ];

    async function requestTelegram(endpoint, params = null, preferredBase = null) {
        const requestOrder = preferredBase
            ? [preferredBase, ...telegramApiBases.filter(base => base !== preferredBase)]
            : telegramApiBases;
        const errors = [];

        for (let i = 0; i < requestOrder.length; i++) {
            const base = requestOrder[i];
            const queryString = params ? `?${params.toString()}` : '';
            const requestUrl = `${base}/bot${token}/${endpoint}${queryString}`;

            try {
                const response = await fetch(requestUrl);
                let data = null;

                try {
                    data = await response.json();
                } catch (jsonError) {
                    if (response.ok) {
                        throw new Error('接口返回了无效的JSON数据');
                    }
                }

                if (!response.ok) {
                    // 401/400 等业务错误通常会携带 JSON，属于“接口可达”，不走备用接口。
                    if (data && typeof data === 'object' && data.ok === false) {
                        return { data, base };
                    }
                    throw new Error(`HTTP ${response.status}`);
                }

                if (!data || typeof data !== 'object') {
                    throw new Error('接口返回数据格式异常');
                }

                return { data, base };
            } catch (error) {
                const host = new URL(base).hostname;
                errors.push(`${host}: ${error.message}`);

                if (i < requestOrder.length - 1) {
                    console.warn(`[TelegramBot] ${host} 请求失败，切换备用接口`, error);
                }
            }
        }

        throw new Error(`官方API与备用API均请求失败（${errors.join('；')}）`);
    }

    if (!token || !chatID) {
        statusEl.textContent = '❌ 请填写Bot Token和Chat ID';
        statusEl.style.display = 'block';
        statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
        statusEl.style.color = '#fff';
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.5';
        return;
    }

    try {
        testBtn.disabled = true;
        statusEl.textContent = '⏳ 验证中...';
        statusEl.style.display = 'block';
        statusEl.style.background = 'linear-gradient(135deg, #3b82f6 0, #1d4ed8 100%)';
        statusEl.style.color = '#fff';

        // 第一步：验证 Bot Token 的有效性
        const getMeResult = await requestTelegram('getMe');
        const getMeData = getMeResult.data;
        if (!getMeData.ok) {
            throw new Error('Bot Token 无效: ' + (getMeData.description || '未知错误'));
        }

        // 第二步：通过Bot Token向Chat ID推送测试消息
        const sendUrlParams = new URLSearchParams({
            chat_id: chatID,
            text: '✅ Telegram 通知配置已验证成功！'
        });
        const sendResult = await requestTelegram('sendMessage', sendUrlParams, getMeResult.base);
        const sendData = sendResult.data;
        if (!sendData.ok) {
            throw new Error('Chat ID 无效: ' + (sendData.description || '未知错误'));
        }

        console.log(`[TelegramBot] 验证成功，当前接口: ${sendResult.base}`);

        // 验证成功
        statusEl.style.background = 'linear-gradient(135deg, #10b981 0, #059669 100%)';
        statusEl.textContent = '✅ Bot Token 和 Chat ID 均有效';
        confirmBtn.disabled = false;
        confirmBtn.style.opacity = '1';

    } catch (error) {
        statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
        statusEl.textContent = '❌ 验证失败: ' + error.message;
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.5';
    } finally {
        testBtn.disabled = false;
    }
}

// 保存 TelegramBot 配置
async function confirmTelegramConfig() {
    const token = document.getElementById('telegramBotToken').value.trim();
    const chatID = document.getElementById('telegramChatID').value.trim();
    const confirmBtn = document.getElementById('telegramConfirmBtn');

    // 检查按钮是否禁用（必须先通过验证）
    if (confirmBtn.disabled) {
        showToast('请先点击"可用性验证"按钮验证配置', 'error');
        return;
    }

    if (!token || !chatID) {
        showToast('请填写完整的Bot Token和Chat ID', 'error');
        return;
    }

    try {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '保存中...';

        // 提交到后端
        const response = await fetch('/admin/tg.json', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                BotToken: token,
                ChatID: chatID
            })
        });

        if (response.ok) {
            const result = await response.json();
            showToast('✅ TelegramBot 配置已保存', 'success');
            closeTelegramConfigModal();

            // 更新按钮状态
            currentConfig.TG = {
                BotToken: token,
                ChatID: chatID,
                启用: true
            };
            updateTelegramButtonStates(true);

            // 1秒后刷新页面
            setTimeout(() => {
                location.reload();
            }, 1000);
        } else {
            const errorData = await response.json();
            showToast('❌ 保存失败: ' + (errorData.error || '未知错误'), 'error');
            confirmBtn.disabled = false;
            confirmBtn.textContent = '保存';
        }
    } catch (error) {
        showToast('❌ 保存失败: ' + error.message, 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = '保存';
    }
}

// 打开 Cloudflare 配置模态框
function openCloudflareConfigModal() {
    document.getElementById('cloudflareConfigModal').classList.add('show');

    // 默认选择第一个方案
    document.getElementById('cloudflareAuthMethod').value = 'accountid';
    updateCloudflareAuthMethod();

    // 清空输入框
    document.getElementById('cloudflareEmail').value = '';
    document.getElementById('cloudflareGlobalAPIKey').value = '';
    document.getElementById('cloudflareAccountID').value = '';
    document.getElementById('cloudflareAPIToken').value = '';
    document.getElementById('cloudflareUsageAPI').value = '';

    // 重置状态和保存按钮
    document.getElementById('cloudflareStatus').style.display = 'none';
    document.getElementById('cloudflareStatus').textContent = '';
    document.getElementById('cloudflareConfirmBtn').disabled = true;
    document.getElementById('cloudflareConfirmBtn').style.opacity = '0.5';
    document.getElementById('cloudflareConfirmBtn').dataset.testPassed = 'false';
}

// 更新 Cloudflare 认证方法选择时的显示
function updateCloudflareAuthMethod() {
    const method = document.getElementById('cloudflareAuthMethod').value;

    // 隐藏所有方案的输入框
    document.getElementById('cloudflareEmailSection').style.display = 'none';
    document.getElementById('cloudflareAccountIDSection').style.display = 'none';
    document.getElementById('cloudflareUsageAPISection').style.display = 'none';

    // 显示选中方案的输入框
    if (method === 'email') {
        document.getElementById('cloudflareEmailSection').style.display = 'block';
    } else if (method === 'accountid') {
        document.getElementById('cloudflareAccountIDSection').style.display = 'block';
    } else if (method === 'usageapi') {
        document.getElementById('cloudflareUsageAPISection').style.display = 'block';
    }

    // 切换方案时重置验证状态和保存按钮
    document.getElementById('cloudflareStatus').style.display = 'none';
    document.getElementById('cloudflareStatus').textContent = '';
    document.getElementById('cloudflareConfirmBtn').disabled = true;
    document.getElementById('cloudflareConfirmBtn').style.opacity = '0.5';
    document.getElementById('cloudflareConfirmBtn').dataset.testPassed = 'false';
}

// 关闭 Cloudflare 配置模态框
function closeCloudflareConfigModal(event) {
    if (event && event.target.id !== 'cloudflareConfigModal') return;
    document.getElementById('cloudflareConfigModal').classList.remove('show');

    // 清空输入框和状态
    document.getElementById('cloudflareEmail').value = '';
    document.getElementById('cloudflareGlobalAPIKey').value = '';
    document.getElementById('cloudflareAccountID').value = '';
    document.getElementById('cloudflareAPIToken').value = '';
    document.getElementById('cloudflareUsageAPI').value = '';
    document.getElementById('cloudflareStatus').style.display = 'none';
    document.getElementById('cloudflareStatus').textContent = '';
}

// 测试 Cloudflare 连接
async function testCloudflareConfig() {
    const method = document.getElementById('cloudflareAuthMethod').value;
    let email = '', globalAPIKey = '', accountID = '', apiToken = '', usageAPI = '';

    const statusEl = document.getElementById('cloudflareStatus');
    const confirmBtn = document.getElementById('cloudflareConfirmBtn');
    const testBtn = event.target;

    // 根据选择的方案获取输入值
    if (method === 'email') {
        email = document.getElementById('cloudflareEmail').value.trim();
        globalAPIKey = document.getElementById('cloudflareGlobalAPIKey').value.trim();

        if (!email || !globalAPIKey) {
            statusEl.textContent = '❌ 请填写 Email 和 Global API Key';
            statusEl.style.display = 'block';
            statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
            statusEl.style.color = '#fff';
            confirmBtn.disabled = true;
            confirmBtn.style.opacity = '0.5';
            confirmBtn.dataset.testPassed = 'false';
            return;
        }
    } else if (method === 'accountid') {
        accountID = document.getElementById('cloudflareAccountID').value.trim();
        apiToken = document.getElementById('cloudflareAPIToken').value.trim();

        if (!accountID || !apiToken) {
            statusEl.textContent = '❌ 请填写 Account ID 和 API Token';
            statusEl.style.display = 'block';
            statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
            statusEl.style.color = '#fff';
            confirmBtn.disabled = true;
            confirmBtn.style.opacity = '0.5';
            confirmBtn.dataset.testPassed = 'false';
            return;
        }
    } else if (method === 'usageapi') {
        usageAPI = document.getElementById('cloudflareUsageAPI').value.trim();

        if (!usageAPI) {
            statusEl.textContent = '❌ 请填写 UsageAPI 地址';
            statusEl.style.display = 'block';
            statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
            statusEl.style.color = '#fff';
            confirmBtn.disabled = true;
            confirmBtn.style.opacity = '0.5';
            confirmBtn.dataset.testPassed = 'false';
            return;
        }
    }

    try {
        testBtn.disabled = true;
        statusEl.textContent = '⏳ 检测中...';
        statusEl.style.display = 'block';
        statusEl.style.background = 'linear-gradient(135deg, #3b82f6 0, #1d4ed8 100%)';
        statusEl.style.color = '#fff';

        let response;

        if (method === 'usageapi') {
            // UsageAPI 方案：直接请求外部 API
            response = await fetch(usageAPI);
        } else {
            // 构建请求 URL
            let queryParams = new URLSearchParams();
            if (method === 'email') {
                queryParams.append('Email', email);
                queryParams.append('GlobalAPIKey', globalAPIKey);
            } else if (method === 'accountid') {
                queryParams.append('AccountID', accountID);
                queryParams.append('APIToken', apiToken);
            }

            response = await fetch('/admin/getCloudflareUsage?' + queryParams.toString());
        }

        if (!response.ok) {
            throw new Error('请求失败 (HTTP ' + response.status + ')');
        }

        const data = await response.json();

        if (data.success) {
            // 验证成功
            statusEl.style.background = 'linear-gradient(135deg, #10b981 0, #059669 100%)';
            const maxQuota = data.max || 100000;
            const percentage = (data.total / maxQuota * 100).toFixed(2);
            statusEl.textContent = `✅ 验证成功！ 今天的请求配额: ${data.total}/${maxQuota} (${percentage}%)`;
            confirmBtn.disabled = false;
            confirmBtn.style.opacity = '1';
            confirmBtn.dataset.testPassed = 'true';

            // 保存验证通过的数据供后续保存使用
            confirmBtn.dataset.method = method;
            confirmBtn.dataset.email = email;
            confirmBtn.dataset.globalAPIKey = globalAPIKey;
            confirmBtn.dataset.accountID = accountID;
            confirmBtn.dataset.apiToken = apiToken;
            confirmBtn.dataset.usageAPI = usageAPI;
        } else {
            // 验证失败
            statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
            statusEl.textContent = '❌ 验证失败：' + (data.msg || '凭证无效或无权限');
            confirmBtn.disabled = true;
            confirmBtn.style.opacity = '0.5';
            confirmBtn.dataset.testPassed = 'false';
        }
    } catch (error) {
        statusEl.style.background = 'linear-gradient(135deg, #ef4444 0, #dc2626 100%)';
        statusEl.textContent = '❌ 检测失败: ' + error.message;
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.5';
        confirmBtn.dataset.testPassed = 'false';
    } finally {
        testBtn.disabled = false;
    }
}

// 保存 Cloudflare 配置
async function confirmCloudflareConfig() {
    const confirmBtn = document.getElementById('cloudflareConfirmBtn');

    // 检查是否通过了验证
    if (confirmBtn.dataset.testPassed !== 'true') {
        showToast('请先点击"可用性验证"按钮通过验证', 'error');
        return;
    }

    const method = confirmBtn.dataset.method;
    const email = confirmBtn.dataset.email || '';
    const globalAPIKey = confirmBtn.dataset.globalAPIKey || '';
    const accountID = confirmBtn.dataset.accountID || '';
    const apiToken = confirmBtn.dataset.apiToken || '';
    const usageAPI = confirmBtn.dataset.usageAPI || '';

    try {
        confirmBtn.disabled = true;
        confirmBtn.textContent = '保存中...';

        // 构建请求体
        let payload;
        if (method === 'usageapi') {
            payload = {
                Email: null,
                GlobalAPIKey: null,
                AccountID: null,
                APIToken: null,
                UsageAPI: usageAPI
            };
        } else {
            payload = {
                Email: method === 'email' ? email : null,
                GlobalAPIKey: method === 'email' ? globalAPIKey : null,
                AccountID: method === 'accountid' ? accountID : null,
                APIToken: method === 'accountid' ? apiToken : null,
                UsageAPI: null
            };
        }

        // 提交到后端
        const response = await fetch('/admin/cf.json', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            showToast('✅ Cloudflare 配置已保存', 'success');
            closeCloudflareConfigModal();

            // 1秒后刷新页面
            setTimeout(() => {
                location.reload();
            }, 1000);
        } else {
            const errorData = await response.json();
            showToast('❌ 保存失败: ' + (errorData.error || '未知错误'), 'error');
            confirmBtn.disabled = false;
            confirmBtn.textContent = '保存';
        }
    } catch (error) {
        showToast('❌ 保存失败: ' + error.message, 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = '保存';
    }
}

// 保存通知设置
async function saveNotification() {
    try {
        // 只更新 TG.启用 字段
        if (!currentConfig.TG) currentConfig.TG = {};
        currentConfig.TG.启用 = document.getElementById('telegramEnabled').checked;

        // 提交到服务器，但整个 currentConfig
        const response = await fetch('/admin/config.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentConfig)
        });

        if (!response.ok) throw new Error('保存失败');

        showToast('✅ 启用状态已保存', 'success');
        modifiedSections.delete('notification');
        updateButtonStates();
    } catch (error) {
        showToast('❌ 保存失败: ' + error.message, 'error');
    }
}

// 清除 Telegram 配置
// 清除 Telegram 配置
function clearTelegramConfig() {
    document.getElementById('clearTelegramModal').classList.add('show');
}

function closeClearTelegramModal(event) {
    if (!event || event.target.id === 'clearTelegramModal') {
        document.getElementById('clearTelegramModal').classList.remove('show');
    }
}

async function confirmClearTelegramConfig() {
    try {
        const response = await fetch('/admin/tg.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ init: true })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            closeClearTelegramModal();
            showToast('✅ Telegram 配置已清除，页面即将刷新...', 'success');
            setTimeout(() => {
                location.reload();
            }, 1000);
        } else {
            showToast('❌ 清除失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('❌ 清除出错: ' + error.message, 'error');
    }
}

// 清除 Cloudflare 配置
function clearCloudflareConfig() {
    document.getElementById('clearCloudflareModal').classList.add('show');
}

function closeClearCloudflareModal(event) {
    if (!event || event.target.id === 'clearCloudflareModal') {
        document.getElementById('clearCloudflareModal').classList.remove('show');
    }
}

async function confirmClearCloudflareConfig() {
    try {
        const response = await fetch('/admin/cf.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ init: true })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            closeClearCloudflareModal();
            showToast('✅ Cloudflare 配置已清除，页面即将刷新...', 'success');
            setTimeout(() => {
                location.reload();
            }, 1000);
        } else {
            showToast('❌ 清除失败: ' + (data.message || '未知错误'), 'error');
        }
    } catch (error) {
        showToast('❌ 清除出错: ' + error.message, 'error');
    }
}

// 取消通知设置编辑
function cancelEdit(section) {
    if (section === 'notification') {
        // 重置通知启用状态为原始值
        const telegramCheckbox = document.getElementById('telegramEnabled');
        const originalEnabled = originalConfig.TG?.启用 ?? false;
        telegramCheckbox.checked = originalEnabled;
        currentConfig.TG.启用 = originalEnabled;
    } else {
        // 原有的cancelEdit逻辑
        currentConfig = JSON.parse(JSON.stringify(originalConfig));

        if (section === 'sub') {
            const local = currentConfig.优选订阅生成?.local ?? true;
            const randomIP = currentConfig.优选订阅生成?.本地IP库?.随机IP ?? true;

            if (!local) {
                document.getElementById('ipMode').value = 'generator';
                document.getElementById('generatorURL').value = currentConfig.优选订阅生成?.SUB || '';
            } else if (randomIP) {
                document.getElementById('ipMode').value = 'random';
                document.getElementById('randomCount').value = currentConfig.优选订阅生成?.本地IP库?.随机数量 || 16;
            } else {
                document.getElementById('ipMode').value = 'custom';
                loadCustomIPs();
            }
            updateIPMode();
        } else if (section === 'config') {
            document.getElementById('subName').value = currentConfig.优选订阅生成?.SUBNAME || '';
            document.getElementById('nodeHost').value = currentConfig.HOST || '';
            document.getElementById('nodeUUID').value = currentConfig.UUID || '';
            document.getElementById('nodePATH').value = currentConfig.PATH || '';
            syncSSProtocolSettingsFromConfig();
            document.getElementById('protocol').value = currentConfig.协议类型 || 'vless';
            syncTransportSettingsFromConfig();
            document.getElementById('skipVerify').checked = currentConfig.跳过证书验证 || false;
            updateProtocol();
        } else if (section === 'proxy') {
            const socksEnabled = currentConfig.反代?.SOCKS5?.启用;
            if (!socksEnabled) {
                document.getElementById('proxyMode').value = 'auto';
                document.getElementById('proxyIP').value = currentConfig.反代?.PROXYIP || '';
                document.getElementById('autoProxy').checked = (currentConfig.反代?.PROXYIP === 'auto');
                if (currentConfig.反代?.PROXYIP === 'auto') {
                    document.getElementById('proxyIP').disabled = true;
                }
            } else if (socksEnabled === 'socks5') {
                document.getElementById('proxyMode').value = 'socks5';
                document.getElementById('socks5Addr').value = currentConfig.反代?.SOCKS5?.账号 || '';
                document.getElementById('globalSocks5').checked = currentConfig.反代?.SOCKS5?.全局 || false;
            } else if (socksEnabled === 'http') {
                document.getElementById('proxyMode').value = 'http';
                document.getElementById('httpAddr').value = currentConfig.反代?.SOCKS5?.账号 || '';
                document.getElementById('globalHTTP').checked = currentConfig.反代?.SOCKS5?.全局 || false;
            } else if (socksEnabled === 'https') {
                document.getElementById('proxyMode').value = 'https';
                document.getElementById('httpsAddr').value = currentConfig.反代?.SOCKS5?.账号 || '';
                document.getElementById('globalHTTPS').checked = currentConfig.反代?.SOCKS5?.全局 || false;
            }
            updateProxyMode();
        } else if (section === 'convert') {
            document.getElementById('subAPI').value = currentConfig.订阅转换配置?.SUBAPI || '';
            document.getElementById('subConfig').value = currentConfig.订阅转换配置?.SUBCONFIG || '';
            document.getElementById('emoji').checked = currentConfig.订阅转换配置?.SUBEMOJI || false;
        }
    }

    modifiedSections.delete(section);
    updateButtonStates();
}

// 更新倒计时
function updateCountdown(forceUpdate = false) {
    const countdownEl = document.getElementById('countdown');
    if (!countdownEl) return;

    const cfUsageModule = document.getElementById('cfUsageModule');
    const moduleVisible = !!cfUsageModule &&
        getComputedStyle(cfUsageModule).display !== 'none' &&
        !cfUsageModule.classList.contains('collapsed');

    if (!forceUpdate && (document.hidden || !moduleVisible)) {
        return;
    }

    const now = new Date();
    const nextMidnightUTC = new Date(now);
    nextMidnightUTC.setUTCHours(0, 0, 0, 0);
    nextMidnightUTC.setUTCDate(nextMidnightUTC.getUTCDate() + 1); // 总是设置为明天的0点

    const diff = nextMidnightUTC - now;
    const hours = String(Math.floor(diff / (1000 * 60 * 60))).padStart(2, '0');
    const minutes = String(Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))).padStart(2, '0');
    const seconds = String(Math.floor((diff % (1000 * 60)) / 1000)).padStart(2, '0');

    if (
        !forceUpdate &&
        countdownEl.dataset.hours === hours &&
        countdownEl.dataset.minutes === minutes &&
        countdownEl.dataset.seconds === seconds
    ) {
        return;
    }

    countdownEl.dataset.hours = hours;
    countdownEl.dataset.minutes = minutes;
    countdownEl.dataset.seconds = seconds;

    const hoursEl = document.getElementById('countdownHours');
    const minutesEl = document.getElementById('countdownMinutes');
    const secondsEl = document.getElementById('countdownSeconds');

    if (hoursEl && minutesEl && secondsEl) {
        hoursEl.textContent = hours;
        minutesEl.textContent = minutes;
        secondsEl.textContent = seconds;
        return;
    }

    countdownEl.textContent = `距离重置还有 ${hours}小时${minutes}分${seconds}秒`;
}

// ==================== 在线优选相关函数 ====================

// IP打码函数 - 将IP中间段打码
function expandIPv6(ip) {
    // 移除可能的[]包围
    ip = ip.replace(/^\[|\]$/g, '');
    // 如果没有::，直接split
    if (!ip.includes('::')) {
        return ip.split(':').map(part => part.padStart(4, '0')).join(':');
    }
    // 处理::
    const parts = ip.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const middle = new Array(missing).fill('0000');
    const full = left.concat(middle).concat(right);
    return full.map(part => part.padStart(4, '0')).join(':');
}

function maskIP(ip) {
    if (!ip) return ip;
    // 检查是否为IPv4
    if (ip.includes('.') && !ip.includes(':')) {
        // IPv4: 例如 192.168.1.1 -> 192.*.*.1
        const parts = ip.split('.');
        if (parts.length === 4) {
            return `${parts[0]}.*.*.${parts[3]}`;
        }
    } else if (ip.includes(':')) {
        // IPv6: 扩展并打码中间部分
        const expanded = expandIPv6(ip);
        const parts = expanded.split(':');
        if (parts.length === 8) {
            return `${parts[0]}:****:****:****:****:****:${parts[6]}:${parts[7]}`;
        }
    }
    return ip;
}

// 切换IP显示模式
function toggleIPDisplay() {
    ipDisplayMode = ipDisplayMode === 'masked' ? 'full' : 'masked';
    updateIPDisplay();
}

// 更新IP显示
function updateIPDisplay() {
    const displayIP = ipDisplayMode === 'masked' ? maskIP(currentDetectedIP) : currentDetectedIP;
    const ipElement = document.getElementById('ipDisplayElement');
    if (ipElement) {
        ipElement.textContent = displayIP;
    }
}

let optimizeResults = {}; // 存储优选结果
let currentSelectedCountry = ''; // 当前选中的国家
let locationsData = []; // 存储位置数据
let currentIPLibrary = ''; // 当前使用的IP库类型
let currentDetectedIP = ''; // 当前检测到的IP
let ipDisplayMode = 'masked'; // IP显示模式: 'masked' 或 'full'

// 打开在线优选模态框
async function openOnlineOptimizeModal() {
    document.getElementById('onlineOptimizeModal').classList.add('show');

    // 重置状态
    optimizeResults = {};
    currentSelectedCountry = '';
    document.getElementById('optimizeProgressBar').classList.add('hidden-section');
    document.getElementById('optimizeResultsTabs').classList.add('hidden-section');
    document.getElementById('optimizeResultsContent').classList.add('hidden-section');
    document.getElementById('btnSaveOverride').disabled = true;
    document.getElementById('btnSaveAppend').disabled = true;
    document.getElementById('btnStartOptimize').disabled = true;
    document.getElementById('btnStartOptimize').textContent = '检测中...';

    // 检测IP和环境
    await detectIPAndEnvironment();
}

// 关闭在线优选模态框
function closeOnlineOptimizeModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('onlineOptimizeModal').classList.remove('show');
}

// ==================== API优选相关函数 ====================

// 打开API优选模态框
function openAPIOptimizeModal() {
    document.getElementById('apiOptimizeModal').classList.add('show');
    // 重置表单
    document.getElementById('apiOptimizeURL').value = '';
    document.getElementById('apiOptimizePort').value = '443';
    document.getElementById('apiOptimizeResults').value = '';
    document.getElementById('useProxyIPCheckbox').checked = false;
    document.getElementById('btnAppendAPI').disabled = true;
    document.getElementById('btnAppendResults').disabled = true;
    // 初始化line-editor
    initLineEditor('apiOptimizeResults');
}

// 关闭API优选模态框
function closeAPIOptimizeModal(event) {
    if (event && event.target !== event.currentTarget) return;
    document.getElementById('apiOptimizeModal').classList.remove('show');
}

// 验证和规范化端口号
function validateAndNormalizePort(port) {
    let num = parseInt(port, 10);
    if (isNaN(num)) return '443';
    if (num < 1) return '1';
    if (num > 65535) return '65535';
    return num.toString();
}

// 验证API URL格式
function isValidURL(url) {
    try {
        new URL(url);
        return true;
    } catch (e) {
        return false;
    }
}

// 将GitHub链接转换为raw格式
function convertGitHubURLToRaw(url) {
    if (!url.includes('github.com')) {
        return url;
    }

    // 将 https://github.com/user/repo/blob/branch/path 转换为 https://raw.githubusercontent.com/user/repo/refs/heads/branch/path
    if (url.includes('/blob/')) {
        // 提取分支和文件路径
        const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.*)/);
        if (match) {
            const [, user, repo, branch, filePath] = match;
            return `https://raw.githubusercontent.com/${user}/${repo}/refs/heads/${branch}/${filePath}`;
        }
    }

    // 将 https://github.com/user/repo/tree/branch/path 转换为 https://raw.githubusercontent.com/user/repo/refs/heads/branch/path
    if (url.includes('/tree/')) {
        const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.*)/);
        if (match) {
            const [, user, repo, branch, filePath] = match;
            return `https://raw.githubusercontent.com/${user}/${repo}/refs/heads/${branch}/${filePath}`;
        }
    }

    return url;
}

// 实时自动转换GitHub链接
function autoConvertGitHubURL() {
    const urlInput = document.getElementById('apiOptimizeURL');
    const url = urlInput.value.trim();

    if (url.includes('github.com/')) {
        const convertedURL = convertGitHubURLToRaw(url);
        if (convertedURL !== url) {
            urlInput.value = convertedURL;
        }
    }
}

// 自动检测URL中的port参数并填充到默认端口字段
function autoDetectPortFromURL() {
    const urlInput = document.getElementById('apiOptimizeURL').value.trim();
    const portInput = document.getElementById('apiOptimizePort');

    if (!urlInput) return;

    try {
        const urlObj = new URL(urlInput);
        const portParam = urlObj.searchParams.get('port');

        if (portParam) {
            // 检测到port参数，验证并规范化
            const normalizedPort = validateAndNormalizePort(portParam);
            portInput.value = normalizedPort;
        }
    } catch (error) {
        // URL格式错误，忽略
        console.log('URL格式检查失败:', error);
    }
}

// 可用性验证
async function verifyAPIOptimize() {
    let urlInput = document.getElementById('apiOptimizeURL').value.trim();
    const portInput = document.getElementById('apiOptimizePort').value.trim();

    if (!urlInput) {
        alert('请输入API URL');
        return;
    }

    // 自动转换GitHub链接为raw格式
    const convertedURL = convertGitHubURLToRaw(urlInput);
    if (convertedURL !== urlInput) {
        document.getElementById('apiOptimizeURL').value = convertedURL;
        urlInput = convertedURL;
        showToast('✅ GitHub链接已自动转换为raw格式', 'info');
    }

    if (!isValidURL(urlInput)) {
        alert('请输入有效的URL格式');
        return;
    }

    // 检测和提取URL中的port参数
    let detectedPort = null;
    let cleanURL = urlInput;

    try {
        const urlObj = new URL(urlInput);
        const portParam = urlObj.searchParams.get('port');

        if (portParam) {
            // 识别到port参数
            detectedPort = validateAndNormalizePort(portParam);

            // 移除port参数
            urlObj.searchParams.delete('port');
            cleanURL = urlObj.toString();

            // 更新URL输入框（移除port参数）
            document.getElementById('apiOptimizeURL').value = cleanURL;

            // 更新端口输入框
            document.getElementById('apiOptimizePort').value = detectedPort;

            showToast(`✅ 已自动识别URL中的端口号: ${detectedPort}，并已移除port参数`, 'success');
        }
    } catch (error) {
        console.log('URL port参数提取失败:', error);
    }

    // 规范化端口（如果没有从URL中检测到端口，则使用输入框中的值）
    const normalizedPort = detectedPort || validateAndNormalizePort(portInput);
    document.getElementById('apiOptimizePort').value = normalizedPort;

    // 使用清理后的URL构建完整URL
    const urlObj = new URL(cleanURL);
    urlObj.searchParams.set('port', normalizedPort);

    // 如果勾选了"将优选作为PROXYIP"，添加proxyip参数
    const useProxyIP = document.getElementById('useProxyIPCheckbox').checked;
    if (useProxyIP) {
        urlObj.searchParams.set('proxyip', 'true');
    }

    const completeURL = urlObj.toString();

    // URL编码
    const encodedURL = encodeURIComponent(completeURL);

    // 构建请求URL
    const requestURL = `/admin/getADDAPI?url=${encodedURL}`;

    try {
        const btn = document.getElementById('btnVerifyAPI');
        btn.disabled = true;
        btn.textContent = '验证中...';

        const response = await fetch(requestURL);
        const data = await response.json();

        if (data.success && data.data && Array.isArray(data.data)) {
            // 接口可用
            const results = data.data.join('\n');
            document.getElementById('apiOptimizeResults').value = results;
            // 刷新line-editor行数
            const resultsTA = document.getElementById('apiOptimizeResults');
            if (resultsTA._refreshLineEditor) {
                resultsTA._refreshLineEditor();
            }
            document.getElementById('btnAppendAPI').disabled = false;
            document.getElementById('btnAppendResults').disabled = false;
            showToast('✅ API接口验证成功！', 'success');
        } else {
            // 接口不可用
            document.getElementById('apiOptimizeResults').value = '❌ 接口不可用，请检查URL和端口是否正确';
            // 刷新line-editor行数
            const resultsTA = document.getElementById('apiOptimizeResults');
            if (resultsTA._refreshLineEditor) {
                resultsTA._refreshLineEditor();
            }
            document.getElementById('btnAppendAPI').disabled = true;
            document.getElementById('btnAppendResults').disabled = true;
            showToast('❌ API接口验证失败，请检查接口', 'error');
        }
    } catch (error) {
        console.error('API验证错误:', error);
        document.getElementById('apiOptimizeResults').value = `❌ 验证出错: ${error.message}`;
        // 刷新line-editor行数
        const resultsTA = document.getElementById('apiOptimizeResults');
        if (resultsTA._refreshLineEditor) {
            resultsTA._refreshLineEditor();
        }
        document.getElementById('btnAppendAPI').disabled = true;
        document.getElementById('btnAppendResults').disabled = true;
        showToast('❌ 验证出错，请稍后重试', 'error');
    } finally {
        const btn = document.getElementById('btnVerifyAPI');
        btn.disabled = false;
        btn.textContent = '可用性验证';
    }
}

// 追加API到自定义优选地址
function appendAPIToCustom() {
    let urlInput = document.getElementById('apiOptimizeURL').value.trim();
    const portInput = document.getElementById('apiOptimizePort').value.trim();
    const useProxyIP = document.getElementById('useProxyIPCheckbox').checked;

    if (!urlInput) {
        alert('请输入API URL');
        return;
    }

    // 移除URL中可能存在的port参数和proxyip参数
    try {
        const urlObj = new URL(urlInput);
        urlObj.searchParams.delete('port');
        urlObj.searchParams.delete('proxyip');
        urlInput = urlObj.toString();
    } catch (error) {
        console.log('URL处理失败:', error);
    }

    // 构建完整URL
    const urlObj = new URL(urlInput);
    urlObj.searchParams.set('port', portInput);

    // 如果勾选了"将优选作为PROXYIP"，添加proxyip参数
    if (useProxyIP) {
        urlObj.searchParams.set('proxyip', 'true');
    }

    const completeURL = urlObj.toString();

    const customIPsTextarea = document.getElementById('customIPs');
    const currentValue = customIPsTextarea.value.trim();

    // 追加到文本框
    if (currentValue) {
        customIPsTextarea.value = currentValue + '\n' + completeURL;
    } else {
        customIPsTextarea.value = completeURL;
    }

    // 刷新line-editor行数
    if (customIPsTextarea._refreshLineEditor) {
        customIPsTextarea._refreshLineEditor();
    }

    // 标记为已修改
    markModified('sub');

    showToast('✅ API URL已追加到自定义优选地址', 'success');
    closeAPIOptimizeModal();
}

// 追加结果到自定义优选地址
function appendResultsToCustom() {
    const resultsTextarea = document.getElementById('apiOptimizeResults');
    const results = resultsTextarea.value.trim();

    if (!results || results.startsWith('❌')) {
        alert('请先进行可用性验证且验证通过');
        return;
    }

    const customIPsTextarea = document.getElementById('customIPs');
    const currentValue = customIPsTextarea.value.trim();

    // 追加到文本框
    if (currentValue) {
        customIPsTextarea.value = currentValue + '\n' + results;
    } else {
        customIPsTextarea.value = results;
    }

    // 刷新line-editor行数
    if (customIPsTextarea._refreshLineEditor) {
        customIPsTextarea._refreshLineEditor();
    }

    // 标记为已修改
    markModified('sub');

    showToast('✅ API结果已追加到自定义优选地址', 'success');
    closeAPIOptimizeModal();
}

// 检测IP和网络环境
async function detectIPAndEnvironment() {
    console.log('[在线优选] 开始: 检测网络环境');
    const detectionBox = document.getElementById('ipDetectionBox');
    const btnStart = document.getElementById('btnStartOptimize');
    detectionBox.innerHTML = '<div class="ip-detection-info">正在检测您的网络环境...</div>';

    try {
        // 首先尝试本地路径
        let response, text;
        try {
            console.log('[在线优选] 进度: 尝试使用当前域名本地路径进行检测');
            response = await fetch(`/cdn-cgi/trace?_t=${Date.now()}`, {
                signal: AbortSignal.timeout(5000), // 5秒超时
                cache: 'no-store' // 禁用所有缓存
            });
            text = await response.text();
            console.log('[在线优选] 成功: 本地路径检测通过（使用本地域名）');
            // 保存使用的检测域名供locations使用
            window.detectDomain = window.location.origin;
        } catch (primaryError) {
            console.warn('[在线优选] 本地路径检测失败，尝试使用主链接 speed.cloudflare.com...', primaryError);
            response = await fetch(`https://speed.cloudflare.com/cdn-cgi/trace?_t=${Date.now()}`, {
                signal: AbortSignal.timeout(5000), // 5秒超时
                cache: 'no-store' // 禁用所有缓存
            });
            text = await response.text();
            console.log('[在线优选] 成功: 主链接检测通过');
            // 保存使用的检测域名供locations使用
            window.detectDomain = 'https://speed.cloudflare.com';
        }
        //console.log('[在线优选] 调试: 检测响应:\n' + text);

        // 解析响应
        const lines = text.trim().split('\n');
        const data = {};
        lines.forEach(line => {
            const [key, value] = line.split('=');
            if (key && value) data[key.trim()] = value.trim();
        });

        const ip = data.ip || '未知';
        const loc = data.loc || '未知';
        currentDetectedIP = ip; // 保存完整IP
        ipDisplayMode = 'masked'; // 默认显示打码IP
        console.log(`[在线优选] 结果: IP=${ip}, 国家=${loc}`);

        // 显示打码的IP，并添加点击事件
        const displayIP = maskIP(ip);
        let html = `<div class="ip-detection-info">当前访问IP: <strong id="ipDisplayElement" style="cursor: pointer; transition: all 0.2s ease;" title="点击切换显示模式">${displayIP}</strong> | 访问国家: <strong>${loc}</strong></div>`;

        if (loc !== 'CN') {
            console.warn('[在线优选] 警告: 检测到非CN地区访问，可能处于代理/VPN环境');
            html += `<div class="ip-detection-warning" style="font-size: 16px; font-weight: 700; color: #dc2626; margin-top: 12px; line-height: 1.6;">⚠️ 检测到您当前很可能处于代理/VPN环境中！请确保处于直连网络环境下再进行在线优选，否则优选测试结果将因为不准确变得毫无意义！</div>`;
            // 非CN地区，禁用开始优选按钮
            btnStart.disabled = true;
            btnStart.textContent = '仅限CN地区';
        } else {
            // CN地区，启用开始优选按钮
            btnStart.disabled = false;
            btnStart.textContent = '开始优选';
            console.log('[在线优选] 成功: 检测为 CN 地区，已启用优选按钮');
        }

        detectionBox.innerHTML = html;

        // 为IP元素添加点击事件
        const ipElement = document.getElementById('ipDisplayElement');
        if (ipElement) {
            ipElement.addEventListener('click', toggleIPDisplay);
        }
    } catch (error) {
        console.error('[在线优选] 检测失败:', error);
        detectionBox.innerHTML = '<div class="ip-detection-info">⚠️ 无法访问 https://speed.cloudflare.com/cdn-cgi/trace 检测网络环境，请检查网络连接或关闭代理</div>';
        // 检测失败，禁用按钮
        btnStart.disabled = true;
        btnStart.textContent = '检测失败';
    }
}

// 验证测试线程数输入
function validateConcurrency(input) {
    let value = parseInt(input.value);
    if (isNaN(value) || value < 1) {
        input.value = 1;
    } else if (value > 32) {
        input.value = 32;
    }
}

// 开始优选
async function startOptimize() {
    console.log('[在线优选] 开始: 优选流程');
    const btnStart = document.getElementById('btnStartOptimize');
    btnStart.disabled = true;
    btnStart.textContent = '优选中...';

    const progressBar = document.getElementById('optimizeProgressBar');
    const progressFill = document.getElementById('optimizeProgressFill');
    const progressText = document.getElementById('optimizeProgressText');
    progressBar.classList.remove('hidden-section');
    progressFill.style.width = '0%';
    progressText.textContent = '0/512 (0.00%)';

    document.getElementById('optimizeResultsTabs').classList.add('hidden-section');
    document.getElementById('optimizeResultsContent').classList.add('hidden-section');

    try {
        // 加载locations数据
        console.log('[在线优选] 步骤1: 加载位置数据');
        await loadLocationsData();

        // 获取用户选择
        const ipLibrary = document.getElementById('optimizeIPLibrary').value;
        const port = document.getElementById('optimizePort').value;
        let concurrency = parseInt(document.getElementById('optimizeConcurrency').value) || 8;

        // 验证并发线程数
        if (isNaN(concurrency) || concurrency < 1 || concurrency > 32) {
            concurrency = 8;
            document.getElementById('optimizeConcurrency').value = '8';
        }

        console.log(`[在线优选] 步骤2: 用户选择 - IP库=${ipLibrary}, 端口=${port}, 并发线程=${concurrency}`);
        currentIPLibrary = ipLibrary; // 保存当前IP库类型

        // 获取IP列表
        console.log('[在线优选] 步骤3: 获取 IP 列表');
        const ips = await getIPList(ipLibrary, port);

        if (ips.length === 0) {
            console.error('[在线优选] 错误: 未能获取到IP列表');
            showToast('未能获取到IP列表', 'error');
            return;
        }

        console.log(`[在线优选] 成功: 已获取 ${ips.length} 个 IP`);

        // 测速（多线程并发）
        console.log('[在线优选] 步骤4: 开始 IP 测速（多线程并发）');
        const results = await testIPsConcurrent(ips, progressFill, progressText, concurrency);
        console.log(`[在线优选] 完成: 测速完成，有效 IP 数量=${results.length}`);

        // 分类结果
        console.log('[在线优选] 步骤5: 开始分类结果');
        classifyResults(results);

        // 显示结果
        console.log('[在线优选] 步骤6: 显示结果');
        displayResults();

        console.log('[在线优选] 完成: 优选流程已完成');
        showToast('优选完成！', 'success');

    } catch (error) {
        console.error('[在线优选] 优选过程出错:', error);
        showToast('优选过程出错: ' + error.message, 'error');
    } finally {
        btnStart.disabled = false;
        btnStart.textContent = '开始优选';
    }
}

// 加载locations数据
async function loadLocationsData() {
    const backupUrl = 'https://zip.cm.edu.kg/locations.json';

    try {
        // 使用当前域名加载位置数据，避免跨域问题
        const url = `${window.detectDomain}/locations`;
        console.log(`[在线优选] 进度: 加载位置数据 URL=${url}`);

        const response = await fetch(url, { headers: { 'Referer': window.detectDomain + '/' } });
        const data = await response.json();

        // 检查返回的数据是否为空对象或空数组
        if (!data || (Array.isArray(data) && data.length === 0) || (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0)) {
            console.warn('[在线优选] 主接口返回空数据，尝试备份接口...');
            throw new Error('主接口返回空数据');
        }

        locationsData = data;
        console.log(`[在线优选] 成功: 已加载 ${locationsData.length} 个位置数据`);
    } catch (error) {
        console.error('[在线优选] 加载locations数据失败:', error);

        // 尝试从备份接口获取
        try {
            console.log(`[在线优选] 进度: 尝试从备份接口加载 URL=${backupUrl}`);
            const backupResponse = await fetch(backupUrl, { headers: { 'Referer': 'https://zip.cm.edu.kg/' } });
            const backupData = await backupResponse.json();

            if (backupData && Array.isArray(backupData) && backupData.length > 0) {
                locationsData = backupData;
                console.log(`[在线优选] 成功: 从备份接口加载到 ${locationsData.length} 个位置数据`);
            } else {
                console.error('[在线优选] 备份接口也返回空数据');
                locationsData = [];
            }
        } catch (backupError) {
            console.error('[在线优选] 备份接口加载失败:', backupError);
            locationsData = [];
        }
    }
}

// 智能镜像拉取函数 - 原始地址与镜像并发抢占，谁先成功就用谁
async function fetchWithAutoMirror(originalUrl, description = '资源') {
    const rawGithubPrefix = 'https://raw.githubusercontent.com';
    const mirrorDomains = [
        'https://github.090227.xyz/raw.githubusercontent.com',
        'https://github.cmliussss.com/raw.githubusercontent.com',
        'https://github.cmliussss.net/raw.githubusercontent.com',
    ];
    const candidates = [{ url: originalUrl, label: '原始链接' }];

    if (originalUrl.startsWith(rawGithubPrefix)) {
        mirrorDomains.forEach((mirrorDomain, index) => {
            candidates.push({
                url: originalUrl.replace(rawGithubPrefix, mirrorDomain),
                label: `备用镜像 ${index + 1}`
            });
        });
    }

    console.log(`[请求RAW] 进度: 并发拉取 ${description}，候选源数量=${candidates.length}`);

    const controllers = candidates.map(() => new AbortController());
    let hasWinner = false;

    const requests = candidates.map((candidate, index) => (async () => {
        try {
            console.log(`[请求RAW] 进度: 发起${candidate.label}请求 URL=${candidate.url}`);
            const response = await fetch(candidate.url, {
                signal: controllers[index].signal
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const text = await response.text();
            return { ...candidate, index, text };
        } catch (error) {
            if (!(hasWinner && error.name === 'AbortError')) {
                console.warn(`[请求RAW] ❌ ${candidate.label}拉取失败: ${error.message}`);
            }
            throw error;
        }
    })());

    try {
        const winner = await Promise.any(requests);
        hasWinner = true;

        controllers.forEach((controller, index) => {
            if (index !== winner.index) {
                controller.abort();
            }
        });

        console.log(`[请求RAW] 成功: 从${winner.label}拉取 ${description}，长度=${winner.text.length} 字符`);
        return winner.text;
    } catch (error) {
        const mirrorCount = Math.max(candidates.length - 1, 0);
        throw new Error(
            mirrorCount > 0
                ? `${description}拉取失败，已尝试原始链接和全部${mirrorCount}个备用镜像`
                : `${description}拉取失败，原始链接不可用`
        );
    }
}

// 获取IP列表
async function getIPList(ipLibrary, port) {
    // 定义各个IP库的原始URLs（仅使用官方地址）
    const urlMap = {
        'cf-official': 'https://cf.090227.xyz/ips-v4',
        'cm-list': 'https://raw.githubusercontent.com/cmliu/cmliu/main/CF-CIDR.txt',
        'as13335': 'https://raw.githubusercontent.com/ipverse/asn-ip/master/as/13335/ipv4-aggregated.txt',
        'as209242': 'https://raw.githubusercontent.com/ipverse/asn-ip/master/as/209242/ipv4-aggregated.txt',
        'reverse-proxy': 'https://zip.cm.edu.kg/all.txt'
    };

    try {
        const url = urlMap[ipLibrary];
        if (!url) throw new Error(`未知的IP库类型: ${ipLibrary}`);

        console.log(`[在线优选] 进度: 获取 ${ipLibrary} 的 IP 列表`);
        const text = await fetchWithAutoMirror(url, `${ipLibrary}数据`);

        if (ipLibrary === 'reverse-proxy') {
            // 处理反向代理列表
            console.log('[在线优选] 进度: 处理反向代理列表');
            return processReverseProxyList(text, port);
        } else {
            // 处理CIDR列表
            console.log('[在线优选] 进度: 处理 CIDR 列表');
            return processCIDRList(text, port);
        }
    } catch (error) {
        console.error('[在线优选] 获取IP列表失败:', error);
        throw new Error('获取IP列表失败: ' + error.message);
    }
}

// 处理反向代理列表
function processReverseProxyList(text, targetPort) {
    const lines = text.trim().split('\n');
    const filteredIPs = [];

    console.log(`[在线优选] 调试: 反向代理列表原始行数=${lines.length}`);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        // 格式: IP:PORT#备注
        const match = trimmed.match(/^([^:]+):(\d+)#(.+)$/);
        if (match) {
            const [, ip, linePort, remark] = match;
            if (linePort === targetPort) {
                filteredIPs.push(`${ip}:${linePort}#${remark}`);
            }
        }
    }

    console.log(`[在线优选] 结果: 匹配端口=${targetPort} 的 IP 数量=${filteredIPs.length}`);

    // 如果超过512个，随机选择512个
    if (filteredIPs.length > 512) {
        console.log('[在线优选] 提示: IP 数量超过 512，将随机选择 512 个');
        return shuffleArray(filteredIPs).slice(0, 512);
    }

    return filteredIPs;
}

// 处理CIDR列表
function processCIDRList(text, port) {
    const lines = text.trim().split('\n');
    const cidrs = lines.filter(line => line.trim() && !line.startsWith('#'));

    console.log(`[在线优选] 调试: CIDR 列表数量=${cidrs.length}`);

    const ips = [];
    const targetCount = 512;

    while (ips.length < targetCount && cidrs.length > 0) {
        for (const cidr of cidrs) {
            if (ips.length >= targetCount) break;

            const ip = generateRandomIPFromCIDR(cidr);
            const ipWithPort = `${ip}:${port}`;

            // 检查是否重复
            if (!ips.includes(ipWithPort)) {
                ips.push(ipWithPort);
            }
        }
    }

    console.log(`[在线优选] 成功: 已生成 ${ips.length} 个随机 IP`);
    return ips;
}

// 从CIDR生成随机IP
function generateRandomIPFromCIDR(cidr) {
    const [network, bits] = cidr.split('/');
    const maskBits = parseInt(bits);
    const networkParts = network.split('.').map(Number);

    // 计算网络地址
    const networkInt = (networkParts[0] << 24) | (networkParts[1] << 16) |
        (networkParts[2] << 8) | networkParts[3];

    // 计算主机位数量
    const hostBits = 32 - maskBits;
    const hostCount = Math.pow(2, hostBits);

    // 随机选择一个主机地址
    const randomHost = Math.floor(Math.random() * hostCount);
    const ipInt = networkInt + randomHost;

    // 转换回IP地址
    const ip1 = (ipInt >>> 24) & 255;
    const ip2 = (ipInt >>> 16) & 255;
    const ip3 = (ipInt >>> 8) & 255;
    const ip4 = ipInt & 255;

    return `${ip1}.${ip2}.${ip3}.${ip4}`;
}

// 测试IP列表（4线程并发版本）
async function testIPsConcurrent(ips, progressFill, progressText, concurrency = 8) {
    const results = [];
    const total = ips.length;
    let completedCount = 0;
    let successCount = 0;
    let failCount = 0;

    console.log(`[在线优选] 开始: 并发测试 总计=${total} 个 IP（线程=${concurrency}）`);

    // 更新进度的函数
    const updateProgress = () => {
        const progress = (completedCount / total * 100).toFixed(2);
        // 计算红色和绿色部分的比例（相对于已完成的IP）
        let failPercent = 0;
        if (completedCount > 0) {
            failPercent = (failCount / completedCount * 100).toFixed(2);
        }

        // 设置进度条的渐变背景，红色表示失败，绿色表示成功
        progressFill.style.background = `linear-gradient(90deg, #ef4444 0%, #ef4444 ${failPercent}%, #10b981 ${failPercent}%, #10b981 100%)`;
        progressFill.style.width = progress + '%';
        progressText.textContent = `${completedCount}/${total} (${progress}%) - 成功: ${successCount}, 失败: ${failCount}`;

        // 每完成64个IP输出一次统计
        if (completedCount % 64 === 0 || completedCount === total) {
            console.log(`[在线优选] 进度: 已完成 ${completedCount}/${total}，成功=${successCount}，失败=${failCount}`);
        }
    };

    // 测试单个IP的包装函数
    const testIPWrapper = async (ipWithPort) => {
        const result = await testSingleIP(ipWithPort);
        completedCount++;

        if (result) {
            results.push(result);
            successCount++;
        } else {
            failCount++;
        }

        updateProgress();
        return result;
    };

    // 并发控制：将IP列表分成多个批次
    const batches = [];
    for (let i = 0; i < ips.length; i += concurrency) {
        batches.push(ips.slice(i, i + concurrency));
    }

    // 逐批次并发执行
    for (const batch of batches) {
        await Promise.all(batch.map(ip => testIPWrapper(ip)));
    }

    console.log(`[在线优选] 完成: 测试完成，总计=${total}，成功=${successCount}，失败=${failCount}`);
    return results;
}

// 测试IP列表（旧版单线程，保留作为备用）
async function testIPs(ips, progressFill) {
    const results = [];
    const total = ips.length;
    let successCount = 0;
    let failCount = 0;

    console.log(`[在线优选] 开始: 开始测试 ${total} 个 IP`);

    for (let i = 0; i < total; i++) {
        const ipWithPort = ips[i];
        const result = await testSingleIP(ipWithPort);

        if (result) {
            results.push(result);
            successCount++;
        } else {
            failCount++;
        }

        // 每测试50个IP输出一次统计
        if ((i + 1) % 50 === 0 || (i + 1) === total) {
            console.log(`[在线优选] 进度: ${i + 1}/${total}，成功=${successCount}，失败=${failCount}`);
        }

        // 更新进度
        const progress = ((i + 1) / total * 100).toFixed(2);
        progressFill.style.width = progress + '%';
        progressFill.textContent = `${i + 1}/${total} (${progress}%)`;
    }

    console.log(`[在线优选] 完成: 测试完成，总计=${total}，成功=${successCount}，失败=${failCount}`);
    return results;
}

// 测试单个IP
async function testSingleIP(ipWithPort) {
    try {
        // 解析IP和端口
        let ip, port, remark = '';
        if (ipWithPort.includes('#')) {
            const [ipPort, remarkPart] = ipWithPort.split('#');
            [ip, port] = ipPort.split(':');
            remark = remarkPart;
        } else {
            [ip, port] = ipWithPort.split(':');
        }

        // 转换IP为16进制
        const hexIP = ipToHex(ip);
        const testUrl = `https://${hexIP}.nip.lfree.org:${port}/cdn-cgi/trace?_t=${Date.now()}`;

        // 测试3次，取后2次平均值
        const times = [];
        let resultData = null;

        for (let i = 0; i < 3; i++) {
            const start = performance.now();
            try {
                const response = await fetch(testUrl, {
                    method: 'GET',
                    signal: AbortSignal.timeout(5000) // 5秒超时
                });

                if (response.ok) {
                    const end = performance.now();
                    const time = end - start;

                    // 第一次不计入（DNS问题）
                    if (i > 0) {
                        times.push(time);
                    }

                    // 只在第一次解析响应数据
                    if (i === 0) {
                        const text = await response.text();
                        const lines = text.trim().split('\n');
                        const data = {};
                        lines.forEach(line => {
                            const [key, value] = line.split('=');
                            if (key && value) data[key] = value;
                        });

                        resultData = {
                            ip: ip,
                            port: port,
                            remark: remark,
                            responseIP: data.ip || ip,
                            colo: data.colo || '',
                            avgTime: 0 // 稍后计算
                        };
                    }
                } else {
                    // 如果第一次就失败，直接返回null
                    if (i === 0) {
                        console.debug(`[在线优选] IP ${ip}:${port} 测试失败 (HTTP ${response.status})`);
                        return null;
                    }
                }
            } catch (error) {
                // 请求失败，如果是第一次就返回null
                if (i === 0) {
                    console.debug(`[在线优选] IP ${ip}:${port} 测试失败 (${error.message})`);
                    return null;
                }
            }
        }

        // 计算平均响应时间
        if (resultData && times.length > 0) {
            const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
            resultData.avgTime = Math.round(avgTime);
            console.debug(`[在线优选] IP ${ip}:${port} 测试成功 - 平均响应: ${resultData.avgTime}ms, colo: ${resultData.colo}`);
            return resultData;
        }

        return null;
    } catch (error) {
        return null;
    }
}

// IP转16进制
function ipToHex(ip) {
    return ip.split('.').map(num => {
        const hex = parseInt(num).toString(16);
        return hex.padStart(2, '0');
    }).join('');
}

// 分类结果
function classifyResults(results) {
    console.log('[在线优选] 开始: 分类结果');
    optimizeResults = {};

    // 根据IP库类型判断是否为优选反代
    // 只有使用"反向代理列表"IP库时，备注才是"优选反代"，其余一律为"官方优选"
    const isReverseProxy = currentIPLibrary === 'reverse-proxy';
    const type = isReverseProxy ? '优选反代' : '官方优选';
    console.log(`[在线优选] 调试: IP库类型=${currentIPLibrary}, 备注类型=${type}`);

    for (const result of results) {
        if (!result.colo) continue;

        // 通过colo查找国家编码
        const location = locationsData.find(loc => loc.iata === result.colo);
        const countryCode = location ? location.cca2 : result.colo;

        if (!optimizeResults[countryCode]) {
            optimizeResults[countryCode] = [];
        }

        optimizeResults[countryCode].push({
            ip: result.ip,
            port: result.port,
            remark: result.remark || countryCode,
            type: type,
            time: result.avgTime
        });
    }

    console.log(`[在线优选] 结果: 已分类到 ${Object.keys(optimizeResults).length} 个国家/地区`);

    // 对每个国家的结果按响应时间排序
    for (const country in optimizeResults) {
        optimizeResults[country].sort((a, b) => a.time - b.time);
        console.log(`[在线优选] 结果: ${country}=${optimizeResults[country].length} 个 IP`);
        // 不再限制为16个，保留所有结果
    }
}

// 显示结果
function displayResults() {
    console.log('[在线优选] 进度: 显示优选结果');
    const tabsContainer = document.getElementById('optimizeResultsTabs');
    const contentContainer = document.getElementById('optimizeResultsContent');

    tabsContainer.innerHTML = '';
    contentContainer.innerHTML = '';

    const countries = Object.keys(optimizeResults).sort();
    console.log(`[在线优选] 结果: 可用国家/地区=${countries.join(', ')}`);

    if (countries.length === 0) {
        console.warn('[在线优选] 警告: 未找到任何可用的优选IP');
        contentContainer.innerHTML = '<div style="text-align: center; color: #6b7280;">未找到可用的优选IP</div>';
        contentContainer.classList.remove('hidden-section');
        return;
    }

    // 创建选项卡 - 显示实际的IP数量
    countries.forEach((country, index) => {
        const tab = document.createElement('div');
        tab.className = 'optimize-tab';
        if (index === 0) {
            tab.classList.add('active');
            currentSelectedCountry = country;
        }
        const actualCount = optimizeResults[country].length;
        tab.textContent = `${country} (${actualCount})`;
        tab.onclick = () => selectCountryTab(country);
        tabsContainer.appendChild(tab);
    });

    // 显示第一个国家的结果
    showCountryResults(currentSelectedCountry);

    tabsContainer.classList.remove('hidden-section');
    contentContainer.classList.remove('hidden-section');

    // 启用保存按钮
    document.getElementById('btnSaveOverride').disabled = false;
    document.getElementById('btnSaveAppend').disabled = false;

    console.log('[在线优选] 完成: 结果显示完成');
}

// 选择国家选项卡
function selectCountryTab(country) {
    currentSelectedCountry = country;

    // 更新选项卡样式
    const tabs = document.querySelectorAll('.optimize-tab');
    tabs.forEach(tab => {
        if (tab.textContent === country) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    // 显示对应国家的结果
    showCountryResults(country);
}

// 显示国家结果
function showCountryResults(country, showAll = false) {
    const contentContainer = document.getElementById('optimizeResultsContent');
    const results = optimizeResults[country] || [];

    if (results.length === 0) {
        contentContainer.innerHTML = '<div style="text-align: center; color: #6b7280;">暂无数据</div>';
        return;
    }

    // 默认只显示前16个，可通过showAll参数显示全部
    const displayCount = showAll ? results.length : Math.min(16, results.length);
    const displayResults = results.slice(0, displayCount);

    const html = displayResults.map(r => {
        // 根据延迟时间确定颜色
        let color = '#10b981'; // 100ms以下绿色
        if (r.time > 100 && r.time <= 200) {
            color = '#f59e0b'; // 101~200ms黄色
        } else if (r.time > 200) {
            color = '#ef4444'; // 201ms以上红色
        }

        return `<div class="optimize-result-item" style="color: ${color}; font-weight: bold;">${r.ip}:${r.port}#${r.remark} ${r.type} ${r.time}ms</div>`;
    }).join('');

    let finalHtml = html;

    // 如果有更多结果且未展开，添加展开按钮
    if (!showAll && results.length > 16) {
        finalHtml += `<div style="margin-top: 15px; text-align: center;">
            <button type="button" class="btn btn-secondary" onclick="showCountryResults('${country}', true)" style="padding: 8px 16px; font-size: 12px;">
                📂 展开所有IP (${results.length} 个)
            </button>
        </div>`;
    }

    contentContainer.innerHTML = finalHtml;
}

// 保存优选结果
async function saveOptimizeResults(mode) {
    console.log(`[在线优选] 进度: 保存结果（模式=${mode}）`);

    if (!currentSelectedCountry || !optimizeResults[currentSelectedCountry]) {
        console.warn('[在线优选] 未选择国家或无结果数据');
        showToast('请先选择一个国家', 'error');
        return;
    }

    const allResults = optimizeResults[currentSelectedCountry];
    // 只保存前16个
    const resultsToSave = allResults.slice(0, 16);
    const newContent = resultsToSave.map(r => `${r.ip}:${r.port}#${r.remark} ${r.type} ${r.time}ms`).join('\n');
    console.log(`[在线优选] 成功: ${currentSelectedCountry} 保存 ${resultsToSave.length} 个 IP（总共 ${allResults.length} 个）`);

    const textarea = document.getElementById('customIPs');

    if (mode === 'override') {
        textarea.value = newContent;
        console.log('[在线优选] 成功: 覆盖保存完成');
        showToast('已覆盖到自定义优选地址 (前16个)', 'success');
    } else if (mode === 'append') {
        const currentValue = textarea.value.trim();

        // 追加保存时进行去重处理
        if (currentValue) {
            // 将现有内容和新内容合并
            const existingLines = currentValue.split('\n').map(line => line.trim()).filter(line => line);
            const newLines = newContent.split('\n').map(line => line.trim()).filter(line => line);

            // 使用 Set 进行去重（基于完整行内容）
            const uniqueLinesSet = new Set(existingLines);
            let addedCount = 0;

            // 添加新行，同时统计实际添加的数量
            newLines.forEach(line => {
                if (!uniqueLinesSet.has(line)) {
                    uniqueLinesSet.add(line);
                    addedCount++;
                }
            });

            // 合并去重后的内容
            textarea.value = Array.from(uniqueLinesSet).join('\n');

            console.log(`[在线优选] 成功: 追加保存完成，新增=${addedCount} 个 IP，重复=${newLines.length - addedCount} 个`);
            if (addedCount === 0) {
                showToast('所有IP均已存在，未添加新内容', 'info');
            } else if (addedCount < newLines.length) {
                showToast(`已追加 ${addedCount} 个新IP，过滤 ${newLines.length - addedCount} 个重复项`, 'success');
            } else {
                showToast(`已追加 ${addedCount} 个IP到自定义优选地址`, 'success');
            }
        } else {
            textarea.value = newContent;
            console.log('[在线优选] 成功: 追加保存完成（原内容为空）');
            showToast('已追加到自定义优选地址 (前16个)', 'success');
        }
    }

    refreshLineEditor(textarea);

    // 标记为已修改
    markModified('sub');
}

// 工具函数：数组随机打乱
function shuffleArray(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

// 初始化
initializeTheme();
window.addEventListener('DOMContentLoaded', () => {
    initializePerformanceMode().catch(err => console.warn('Performance mode initialization failed:', err));
    loadConfig();
    initUserMode();
    initLineEditor('customIPs');
    initNodeUUIDEasterEgg();
    // 独立预加载 SubConfig 数据，不阻塞主流程
    loadSubConfigData().catch(err => console.error('SubConfig预加载失败:', err));
});

// 启动倒计时更新
setInterval(updateCountdown, 1000);
updateCountdown(); // 立即执行一次

// ==================== 网络信息相关函数 ====================

// 设置状态指示器
function setStatus(id, status) {
    const indicator = document.getElementById(id);
    if (indicator) {
        indicator.className = 'status-indicator status-' + status;
    }
}

// 网络信息默认脱敏显示（点击卡片可显示真实值）
let networkPrivacyVisible = false;
const NETWORK_FIELD_CONFIGS = [
    { id: 'ipip-ip', type: 'ip' },
    { id: 'overseas-ip', type: 'ip' },
    { id: 'cf-ip', type: 'ip' },
    { id: 'twitter-ip', type: 'ip' },
    { id: 'ipip-country', type: 'location' },
    { id: 'overseas-country', type: 'location' },
    { id: 'cf-country', type: 'location' },
    { id: 'twitter-country', type: 'location' }
];
const NETWORK_API_TIMEOUT_MS = 6180.3;

async function fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_API_TIMEOUT_MS) {
    const { signal: externalSignal, ...fetchOptions } = options || {};
    const timeoutController = new AbortController();
    let timeoutReached = false;
    let externalAbortHandler = null;

    if (externalSignal) {
        if (externalSignal.aborted) {
            timeoutController.abort();
        } else {
            externalAbortHandler = () => timeoutController.abort();
            externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
        }
    }

    const timeoutId = setTimeout(() => {
        timeoutReached = true;
        timeoutController.abort();
    }, timeoutMs);

    try {
        return await fetch(url, { ...fetchOptions, signal: timeoutController.signal });
    } catch (error) {
        if (timeoutReached) {
            throw new Error(`request timeout after ${timeoutMs}ms: ${url}`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
        if (externalSignal && externalAbortHandler) {
            externalSignal.removeEventListener('abort', externalAbortHandler);
        }
    }
}

function maskNetworkIpValue(ip) {
    const value = String(ip || '').trim();
    if (!value || value === '未知') return value;

    if (value.includes('.') && !value.includes(':')) {
        const parts = value.split('.');
        if (parts.length === 4) {
            return `${parts[0]}.${'*'.repeat(parts[1].length)}.${'*'.repeat(parts[2].length)}.${'*'.repeat(parts[3].length)}`;
        }
    }

    if (value.includes(':')) {
        const hasBrackets = value.startsWith('[') && value.endsWith(']');
        const pureValue = hasBrackets ? value.slice(1, -1) : value;
        const [baseIp, zoneSuffix = ''] = pureValue.split('%');
        const firstColonIndex = baseIp.indexOf(':');
        if (firstColonIndex === -1) {
            return value;
        }

        const firstSegment = baseIp.slice(0, firstColonIndex);
        const remain = baseIp.slice(firstColonIndex + 1);
        const maskedRemain = remain.replace(/[^:]/g, '*');
        const maskedBase = `${firstSegment}:${maskedRemain}`;
        const maskedWithZone = zoneSuffix ? `${maskedBase}%${zoneSuffix}` : maskedBase;
        return hasBrackets ? `[${maskedWithZone}]` : maskedWithZone;
    }

    return value.length <= 2 ? '*'.repeat(Math.max(2, value.length)) : `${value.slice(0, 2)}${'*'.repeat(value.length - 2)}`;
}

function maskNetworkLocationValue(location) {
    const value = String(location || '').trim();
    if (!value || value === '未知') return value;

    const tokens = value.split(/\s+/).filter(Boolean);
    if (!tokens.length) return value;

    return tokens.map((token, index) => {
        if (index === 0 && /^[a-zA-Z]{2}$/.test(token)) {
            return token.toUpperCase();
        }
        return '*'.repeat(Math.max(2, token.length));
    }).join(' ');
}

function stopNetworkFieldAnimation(fieldElement) {
    if (!fieldElement) return;
    if (fieldElement._privacyAnimFrame) {
        cancelAnimationFrame(fieldElement._privacyAnimFrame);
        fieldElement._privacyAnimFrame = null;
    }
}

function animateNetworkFieldDisplay(fieldElement, targetText, durationMs = 160) {//逐字符替换速度
    if (!fieldElement) return;
    stopNetworkFieldAnimation(fieldElement);

    const fromText = String(fieldElement.textContent || '');
    const toText = String(targetText || '');
    if (fromText === toText) {
        fieldElement.textContent = toText;
        return;
    }

    const maxLen = Math.max(fromText.length, toText.length);
    const fromChars = fromText.padEnd(maxLen, ' ').split('');
    const toChars = toText.padEnd(maxLen, ' ').split('');
    const diffIndexes = [];
    for (let i = 0; i < maxLen; i++) {
        if (fromChars[i] !== toChars[i]) diffIndexes.push(i);
    }

    if (!diffIndexes.length) {
        fieldElement.textContent = toText;
        return;
    }

    const startTime = performance.now();
    const frame = now => {
        const progress = Math.min((now - startTime) / durationMs, 1);
        const changedCount = Math.floor(progress * diffIndexes.length);

        const currentChars = fromChars.slice();
        for (let i = 0; i < changedCount; i++) {
            const idx = diffIndexes[i];
            currentChars[idx] = toChars[idx];
        }

        fieldElement.textContent = currentChars.join('').trimEnd();

        if (progress < 1) {
            fieldElement._privacyAnimFrame = requestAnimationFrame(frame);
        } else {
            fieldElement._privacyAnimFrame = null;
            fieldElement.textContent = toText;
        }
    };

    fieldElement._privacyAnimFrame = requestAnimationFrame(frame);
}

function renderNetworkFieldDisplay(fieldElement, options = {}) {
    if (!fieldElement) return;
    if (fieldElement.dataset.displayState !== 'ready') return;
    const { animate = false } = options;

    const rawValue = String(fieldElement.dataset.rawValue || '').trim();
    const maskType = fieldElement.dataset.maskType || 'location';

    if (!rawValue) {
        stopNetworkFieldAnimation(fieldElement);
        fieldElement.textContent = '';
        return;
    }

    let displayValue = rawValue;
    if (!networkPrivacyVisible) {
        displayValue = maskType === 'ip'
            ? maskNetworkIpValue(rawValue)
            : maskNetworkLocationValue(rawValue);
    }

    if (animate) {
        animateNetworkFieldDisplay(fieldElement, displayValue);
    } else {
        stopNetworkFieldAnimation(fieldElement);
        fieldElement.textContent = displayValue;
    }
}

function setNetworkFieldValue(fieldId, rawValue, maskType) {
    const fieldElement = document.getElementById(fieldId);
    if (!fieldElement) return;

    fieldElement.dataset.rawValue = String(rawValue || '').trim();
    fieldElement.dataset.maskType = maskType;
    fieldElement.dataset.displayState = 'ready';
    renderNetworkFieldDisplay(fieldElement);

    // IP 字段加载完成后立即就绪点击查询，不等待其它卡片
    if (maskType === 'ip') {
        makeIpClickable();
    }
}

function setNetworkFieldError(fieldId, errorText) {
    const fieldElement = document.getElementById(fieldId);
    if (!fieldElement) return;

    stopNetworkFieldAnimation(fieldElement);
    fieldElement.dataset.rawValue = '';
    fieldElement.dataset.displayState = 'error';
    fieldElement.classList.remove('clickable', 'is-loading');
    fieldElement.removeAttribute('title');
    fieldElement.removeAttribute('aria-busy');
    fieldElement.innerHTML = `<span class="error">${errorText}</span>`;
}

function clearNetworkFieldValue(fieldId) {
    const fieldElement = document.getElementById(fieldId);
    if (!fieldElement) return;

    stopNetworkFieldAnimation(fieldElement);
    fieldElement.dataset.rawValue = '';
    fieldElement.dataset.displayState = 'empty';
    fieldElement.classList.remove('clickable', 'is-loading');
    fieldElement.removeAttribute('title');
    fieldElement.removeAttribute('aria-busy');
    fieldElement.textContent = '';
}

function refreshAllNetworkFieldDisplays(animate = false) {
    NETWORK_FIELD_CONFIGS.forEach(({ id }) => {
        const fieldElement = document.getElementById(id);
        renderNetworkFieldDisplay(fieldElement, { animate });
    });

    applyNetworkCardFlag('ipip-country');
    applyNetworkCardFlag('overseas-country');
    applyNetworkCardFlag('cf-country');
    applyNetworkCardFlag('twitter-country');
}

function toggleNetworkPrivacy(event) {
    if (event) event.stopPropagation();
    networkPrivacyVisible = !networkPrivacyVisible;
    refreshAllNetworkFieldDisplays(true);
}

function bindNetworkCardPrivacyToggle() {
    const cards = document.querySelectorAll('.network-cards-container .network-card');
    cards.forEach(card => {
        if (card.dataset.privacyToggleBound === '1') return;
        card.dataset.privacyToggleBound = '1';
        card.title = '点击卡片可显示/隐藏真实IP和地址';
        card.addEventListener('click', toggleNetworkPrivacy);
    });
}

// 根据卡片内国家缩写设置国旗角标
function applyNetworkCardFlag(countryElementId) {
    const countryElement = document.getElementById(countryElementId);
    if (!countryElement) return;

    const networkCard = countryElement.closest('.network-card');
    if (!networkCard) return;

    const countryText = String(countryElement.dataset.rawValue || countryElement.textContent || '').trim();
    const codeMatch = countryText.match(/\b([a-zA-Z]{2})\b/);
    const countryCode = codeMatch ? codeMatch[1].toLowerCase() : '';

    if (!countryCode) {
        networkCard.classList.remove('has-flag-badge');
        networkCard.style.removeProperty('--flag-badge-url');
        return;
    }

    networkCard.style.setProperty('--flag-badge-url', `url("https://ipdata.co/flags/${countryCode}.png")`);
    networkCard.classList.add('has-flag-badge');
}

// JSONP 请求工具（用于无 CORS 的接口）
function createJsonpRequest(url, callbackParam, timeoutMs = NETWORK_API_TIMEOUT_MS) {
    let settled = false;
    let timeoutId = null;
    let script = null;
    let callbackScope = null;
    let callbackKey = null;
    let rejectPromise = null;

    const cleanup = () => {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        if (script && script.parentNode) {
            script.parentNode.removeChild(script);
        }
        if (callbackScope && callbackKey) {
            try {
                delete callbackScope[callbackKey];
            } catch {
                callbackScope[callbackKey] = undefined;
            }
        }
    };

    const promise = new Promise((resolve, reject) => {
        rejectPromise = reject;

        const finalize = (handler, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            handler(value);
        };

        const callbackPath = `window.__EDT2_IP_TEST_.__${Date.now()}_${Math.floor(Math.random() * 1e16)}__`;
        const callbackChain = callbackPath.replace(/^window\./, '').split('.');

        callbackScope = window;
        for (let i = 0; i < callbackChain.length - 1; i++) {
            const key = callbackChain[i];
            if (!callbackScope[key] || typeof callbackScope[key] !== 'object') {
                callbackScope[key] = {};
            }
            callbackScope = callbackScope[key];
        }
        callbackKey = callbackChain[callbackChain.length - 1];
        callbackScope[callbackKey] = payload => finalize(resolve, payload);

        const requestUrl = new URL(url);
        requestUrl.searchParams.set(callbackParam, callbackPath);
        requestUrl.searchParams.set('_t', Date.now().toString());

        script = document.createElement('script');
        script.src = requestUrl.toString();
        script.async = true;
        script.referrerPolicy = 'no-referrer';
        script.onerror = () => finalize(reject, new Error(`JSONP load failed: ${url}`));

        timeoutId = setTimeout(() => {
            finalize(reject, new Error(`JSONP timeout: ${url}`));
        }, timeoutMs);

        document.head.appendChild(script);
    });

    return {
        promise,
        cancel: () => {
            if (!settled && rejectPromise) {
                settled = true;
                cleanup();
                rejectPromise(new Error(`JSONP cancelled: ${url}`));
            } else {
                cleanup();
            }
        }
    };
}

// 统一调用 IP 详情接口（按 IP 查询）
async function fetchIpInfoByIp(ip) {
    const requestIp = String(ip || '').trim();
    if (!requestIp) {
        throw new Error('missing ip');
    }

    const apis = [
        {
            name: 'cm-cf',
            url: `https://api.090227.xyz/api/ipsb?ip=${encodeURIComponent(requestIp)}`
        }
    ];

    const requestTasks = apis.map(async api => {
        const response = await fetchWithTimeout(api.url, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`${api.name} HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!data || typeof data !== 'object') {
            throw new Error(`${api.name} invalid payload`);
        }
        return data;
    });

    try {
        return await Promise.any(requestTasks);
    } catch (error) {
        throw new Error(`ipinfo all failed for ${requestIp}`);
    }
}

function formatIpInfoLocation(info) {
    const countryCode = String(info?.country_code || '未知').trim() || '未知';
    const rawAsn = info?.asn;
    const asnText = rawAsn === undefined || rawAsn === null
        ? ''
        : (/^\d+$/.test(String(rawAsn).trim()) ? `AS${String(rawAsn).trim()}` : String(rawAsn).trim());
    const asnName = String(
        info?.as_name ||
        info?.asn_organization ||
        info?.organization ||
        info?.isp ||
        ''
    ).trim();

    return `${countryCode} ${asnText} ${asnName}`.trim() || '未知';
}

// 获取国内测试数据 (多源并发：HEAD + JSONP，提取IP后查询ipinfo)
async function fetchIpipData() {
    setStatus('status-ipip', 'loading');

    const statusElement = document.querySelector('#status-ipip');
    const titleElement = statusElement ? statusElement.parentElement : null;
    const testSources = [
        {
            type: 'head',
            name: '字节跳动',
            url: 'https://perfops2.byte-test.com/500b-bench.jpg',
            ipHeader: 'X-Request-Ip'
        },
        {
            type: 'head',
            name: '字节跳动',
            url: 'https://perfops.byte-test.com',
            ipHeader: 'X-Request-Ip'
        },
        {
            type: 'head',
            name: '网易科技',
            url: 'https://necaptcha.nosdn.127.net/ab7f4275c1744aa28e0a8f3a1c58c532.png',
            ipHeader: 'cdn-user-ip'
        },
        {
            type: 'jsonp',
            name: '腾讯新闻',
            url: 'https://r.inews.qq.com/api/ip2city?otype=jsonp',
            callbackParam: 'callback',
            extractIp: payload => payload?.ip
        },
        {
            type: 'jsonp',
            name: '太平洋科技',
            url: 'https://whois.pconline.com.cn/ipJson.jsp',
            callbackParam: 'callback',
            extractIp: payload => payload?.ip
        },
        {
            type: 'jsonp',
            name: '阿里巴巴',
            url: `https://${Date.now()}.dns-detect.alicdn.com/api/detect/DescribeDNSLookup`,
            callbackParam: 'cb',
            extractIp: payload => payload?.content?.localIp
        }
    ];
    const requestTasks = testSources.map(sourceConfig => {
        if (sourceConfig.type === 'jsonp') {
            const jsonpTask = createJsonpRequest(sourceConfig.url, sourceConfig.callbackParam);
            return {
                cancel: jsonpTask.cancel,
                promise: jsonpTask.promise.then(payload => {
                    const requestIp = String(sourceConfig.extractIp(payload) || '').trim();
                    if (!requestIp) {
                        throw new Error(`${sourceConfig.url} missing jsonp ip`);
                    }
                    return {
                        source: sourceConfig.url,
                        requestIp,
                        providerName: sourceConfig.name
                    };
                })
            };
        }

        const controller = new AbortController();
        return {
            cancel: () => controller.abort(),
            promise: (async () => {
                const url = `${sourceConfig.url}${sourceConfig.url.includes('?') ? '&' : '?'}_t=${Date.now()}`;
                const response = await fetchWithTimeout(url, {
                    method: 'HEAD',
                    cache: 'no-store',
                    signal: controller.signal
                });

                if (!response.ok) {
                    throw new Error(`${sourceConfig.url} HTTP ${response.status}`);
                }

                const requestIp = String(response.headers.get(sourceConfig.ipHeader) || '').trim();
                if (!requestIp) {
                    throw new Error(`${sourceConfig.url} missing ${sourceConfig.ipHeader}`);
                }

                return {
                    source: sourceConfig.url,
                    requestIp,
                    providerName: sourceConfig.name
                };
            })()
        };
    });

    let fastestSuccess;
    try {
        fastestSuccess = await Promise.any(requestTasks.map(task => task.promise));
    } catch (error) {
        requestTasks.forEach(task => task.cancel && task.cancel());

        setNetworkFieldError('ipip-ip', '加载失败');
        clearNetworkFieldValue('ipip-country');
        applyNetworkCardFlag('ipip-country');
        const ipipCityElement = document.getElementById('ipip-city');
        if (ipipCityElement) {
            ipipCityElement.textContent = '';
        }
        setStatus('status-ipip', 'error');
        console.error('国内测试 所有测试源都失败:', error);
        return;
    }

    requestTasks.forEach(task => task.cancel && task.cancel());

    const fallbackIp = String(fastestSuccess.requestIp || '未知').trim() || '未知';
    setNetworkFieldValue('ipip-ip', fallbackIp, 'ip');
    clearNetworkFieldValue('ipip-country');
    applyNetworkCardFlag('ipip-country');

    if (titleElement) {
        titleElement.innerHTML = `<span class="status-indicator" id="status-ipip"></span><div class="title-text"><div class="title-main">国内测试</div><div class="title-subtitle">${fastestSuccess.providerName}</div></div>`;
        setStatus('status-ipip', 'loading');
    }

    try {
        const info = await fetchIpInfoByIp(fastestSuccess.requestIp);
        const ip = String(info.ip || fastestSuccess.requestIp || '未知').trim();
        const location = formatIpInfoLocation(info);

        setNetworkFieldValue('ipip-ip', ip, 'ip');
        setNetworkFieldValue('ipip-country', location || '未知', 'location');
        applyNetworkCardFlag('ipip-country');
        setStatus('status-ipip', 'success');
        console.log(`[国内测试] 成功: IP=${ip}, 位置=${location}, 来源=${fastestSuccess.source}`);
    } catch (detailError) {
        setNetworkFieldValue('ipip-country', '未知', 'location');
        applyNetworkCardFlag('ipip-country');
        setStatus('status-ipip', 'success');
        console.warn(`[国内测试] 已获取IP=${fallbackIp}，但查询详细信息失败:`, detailError);
    }
}

// 获取国外测试数据
async function fetchOverseasTestData() {
    setStatus('status-overseas', 'loading');
    // API 配置：URL + 字段映射
    const apis = [
        {
            url: `https://api.ipapi.is`,
            parse: d => ({ ip: d.ip, loc: `${d.location?.country_code || '未知'} AS${d.asn?.asn || ''} ${d.asn?.org || ''}`.trim() })
        },
        {
            url: `https://api.cmliussss.net/api/ipinfo?_t=${Date.now()}`,
            parse: d => ({ ip: d.ip, loc: `${d.country_code || '未知'} ${d.asn || ''} ${d.as_name || ''}`.trim() })
        }
    ];

    for (const api of apis) {
        try {
            const response = await fetchWithTimeout(api.url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const { ip, loc } = api.parse(await response.json());
            const edgeIp = ip || '未知';

            setNetworkFieldValue('overseas-ip', edgeIp, 'ip');
            setNetworkFieldValue('overseas-country', loc || '未知', 'location');
            applyNetworkCardFlag('overseas-country');
            setStatus('status-overseas', 'success');
            console.log(`[国外测试] 成功: IP=${edgeIp}, 位置=${loc}`);
            return;
        } catch (error) {
            console.log(`[国外测试] ${api.url} 失败: ${error.message}`);
        }
    }

    // 所有 API 都失败
    setNetworkFieldError('overseas-ip', '加载失败');
    clearNetworkFieldValue('overseas-country');
    applyNetworkCardFlag('overseas-country');
    setStatus('status-overseas', 'error');
    console.error('国外测试 所有API都失败');
}

// CloudFlare ProxyIP 卡片状态（支持双出口切换）
let cloudFlareEntries = [];
let cloudFlareActiveIndex = 0;

function isValidIpv4(ip) {
    const value = String(ip || '').trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
    return value.split('.').every(part => {
        if (!/^\d+$/.test(part)) return false;
        const num = Number(part);
        return num >= 0 && num <= 255;
    });
}

function isValidIpv6(ip) {
    const value = String(ip || '').trim().replace(/^\[|\]$/g, '');
    if (!value || !value.includes(':')) return false;
    try {
        // 借助 URL 解析器校验 IPv6 格式，兼容缩写写法
        new URL(`http://[${value}]/`);
        return true;
    } catch {
        return false;
    }
}

function detectIpVersion(ip) {
    const value = String(ip || '').trim();
    if (!value) return '';
    if (isValidIpv4(value)) return 'v4';
    if (isValidIpv6(value)) return 'v6';
    return '';
}

function getCloudFlareProxyClass(version) {
    if (version === 'v4') return 'cf-subtitle-v4';
    if (version === 'v6') return 'cf-subtitle-v6';
    return '';
}

function getCloudFlareProxyLabel(version, full = false) {
    if (version === 'v4') return full ? 'ProxyIPv4' : 'v4';
    if (version === 'v6') return full ? 'ProxyIPv6' : 'v6';
    return full ? 'ProxyIP' : 'IP';
}

function formatCloudFlareLocation(data) {
    const country = String(data?.country || '').trim();
    const org = String(data?.org || '').trim();
    return `${country} ${org}`.trim() || '未知';
}

function resetCloudFlareSubtitle() {
    const subtitleElement = document.getElementById('cf-subtitle');
    if (!subtitleElement) return;
    subtitleElement.classList.remove('cf-subtitle-rich');
    subtitleElement.textContent = 'ProxyIP';
}

function renderCloudFlareSubtitle() {
    const subtitleElement = document.getElementById('cf-subtitle');
    if (!subtitleElement) return;

    if (!cloudFlareEntries.length) {
        resetCloudFlareSubtitle();
        return;
    }

    subtitleElement.classList.add('cf-subtitle-rich');

    if (cloudFlareEntries.length === 1) {
        const entry = cloudFlareEntries[0];
        subtitleElement.innerHTML = `<span class="${getCloudFlareProxyClass(entry.version)}">${getCloudFlareProxyLabel(entry.version, true)}</span>`;
        return;
    }

    cloudFlareActiveIndex = Math.min(Math.max(cloudFlareActiveIndex, 0), cloudFlareEntries.length - 1);
    const onSwitch = event => {
        event.preventDefault();
        event.stopPropagation();
        const targetIndex = Number(event.currentTarget.dataset.cfTargetIndex);
        if (!Number.isInteger(targetIndex)) return;
        if (targetIndex < 0 || targetIndex >= cloudFlareEntries.length) return;
        if (targetIndex === cloudFlareActiveIndex) return;

        cloudFlareActiveIndex = targetIndex;
        renderCloudFlareActiveEntry();
    };

    const subtitleHtml = cloudFlareEntries.map((entry, index) => {
        const entryClass = getCloudFlareProxyClass(entry.version);
        const isActive = index === cloudFlareActiveIndex;
        const label = getCloudFlareProxyLabel(entry.version, isActive);
        if (isActive) {
            return `<span class="${entryClass}">${label}</span>`;
        }

        return `<span class="${entryClass} cf-subtitle-switch" data-cf-target-index="${index}" role="button" tabindex="0">${label}</span>`;
    }).join('<span class="cf-subtitle-sep"> / </span>');

    subtitleElement.innerHTML = subtitleHtml;

    const switchElements = subtitleElement.querySelectorAll('.cf-subtitle-switch');
    switchElements.forEach(switchElement => {
        switchElement.title = '点击切换出口IP';
        switchElement.addEventListener('click', onSwitch);
        switchElement.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            onSwitch(event);
        });
    });
}

function renderCloudFlareActiveEntry() {
    if (!cloudFlareEntries.length) return;
    cloudFlareActiveIndex = Math.min(Math.max(cloudFlareActiveIndex, 0), cloudFlareEntries.length - 1);

    const activeEntry = cloudFlareEntries[cloudFlareActiveIndex];
    setNetworkFieldValue('cf-ip', activeEntry.ip, 'ip');
    setNetworkFieldValue('cf-country', activeEntry.loc || '未知', 'location');
    applyNetworkCardFlag('cf-country');
    renderCloudFlareSubtitle();
}

// 获取 CloudFlare 数据（并发请求多个接口，按实际返回 IP 判定类型）
async function fetchCloudFlareData() {
    setStatus('status-cf', 'loading');
    cloudFlareEntries = [];
    cloudFlareActiveIndex = 0;
    resetCloudFlareSubtitle();

    const timestamp = Date.now();
    const endpoints = [
        { url: 'https://ipv4.090227.xyz' },
        { url: 'https://ipv6.090227.xyz' }
    ];

    try {
        const requestResults = await Promise.allSettled(
            endpoints.map(async endpoint => {
                const response = await fetchWithTimeout(`${endpoint.url}/?_t=${timestamp}`, { cache: 'no-store' });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();
                const ip = String(data?.ip || '').trim();
                const version = detectIpVersion(ip);
                if (!ip || !version) {
                    throw new Error(`invalid ip payload: ${ip || 'empty'}`);
                }

                return {
                    ip,
                    version,
                    loc: formatCloudFlareLocation(data)
                };
            })
        );

        const availableEntries = [];
        const seenEntryKeys = new Set();

        requestResults.forEach((result, index) => {
            const endpoint = endpoints[index];
            if (result.status !== 'fulfilled') {
                const reason = result.reason?.message || String(result.reason || 'unknown error');
                console.log(`[CloudFlare] ${endpoint.url} 失败: ${reason}`);
                return;
            }

            const entry = result.value;
            if (!entry?.ip || !entry?.version) return;
            const normalizedIp = String(entry.ip || '').trim().toLowerCase();
            const dedupeKey = `${entry.version}:${normalizedIp}`;
            if (seenEntryKeys.has(dedupeKey)) {
                return;
            }
            seenEntryKeys.add(dedupeKey);
            availableEntries.push(entry);
        });

        if (!availableEntries.length) {
            throw new Error('no valid cloudflare ip from all endpoints');
        }

        const hasV4 = availableEntries.some(entry => entry.version === 'v4');
        const hasV6 = availableEntries.some(entry => entry.version === 'v6');
        if (hasV4 && hasV6) {
            availableEntries.sort((a, b) => {
                if (a.version === b.version) return 0;
                return a.version === 'v4' ? -1 : 1;
            });
        }

        cloudFlareEntries = availableEntries;
        cloudFlareActiveIndex = 0;
        renderCloudFlareActiveEntry();
        setStatus('status-cf', 'success');

        const summary = cloudFlareEntries.map(entry => `${entry.ip}(${entry.version})`).join(', ');
        console.log(`[CloudFlare] 成功: ${summary}`);
    } catch (error) {
        setNetworkFieldError('cf-ip', '加载失败');
        clearNetworkFieldValue('cf-country');
        applyNetworkCardFlag('cf-country');
        resetCloudFlareSubtitle();
        setStatus('status-cf', 'error');
        console.error('CloudFlare 接口错误:', error);
    }
}

// 获取墙外测试数据（谷歌优先，失败回退 X.com）
async function fetchTwitterData() {
    setStatus('status-twitter', 'loading');
    const statusElement = document.querySelector('#status-twitter');
    const titleElement = statusElement ? statusElement.parentElement : null;
    const tipElement = document.getElementById('twitter-tip');
    const isInvalidOutsideEntryIp = ip => {
        const candidate = String(ip || '').trim();
        return !candidate || candidate === '0.0.0.0';
    };

    const renderTwitterTitle = (subtitle) => {
        if (!titleElement) return;
        titleElement.innerHTML = `<span class="status-indicator" id="status-twitter"></span><div class="title-text"><div class="title-main">墙外测试</div><div class="title-subtitle">${subtitle}</div></div>`;
    };

    const renderTwitterTip = (sourceName) => {
        if (!tipElement) return;
        tipElement.textContent = `· 您访问 ${sourceName} 所使用的IP`;
    };

    const testSources = [
        {
            name: '谷歌(Google)',
            getIp: async () => {
                const jsonpTask = createJsonpRequest(`https://jsonp-ip.appspot.com/?_t=${Date.now()}`, 'callback');
                try {
                    const payload = await jsonpTask.promise;
                    const requestIp = String(payload?.ip || '').trim();
                    if (isInvalidOutsideEntryIp(requestIp)) {
                        if (requestIp === '0.0.0.0') {
                            throw new Error('google jsonp returned invalid ip 0.0.0.0');
                        }
                        throw new Error('google jsonp missing ip');
                    }
                    return requestIp;
                } finally {
                    jsonpTask.cancel();
                }
            }
        },
        {
            name: '推特(X.com)',
            getIp: async () => {
                const response = await fetchWithTimeout(`https://help.x.com/cdn-cgi/trace?_t=${Date.now()}`, {
                    cache: 'no-store'
                });
                if (!response.ok) {
                    throw new Error(`x trace HTTP ${response.status}`);
                }

                const text = await response.text();
                const ipLine = text.split('\n').find(line => line.startsWith('ip='));
                const requestIp = String(ipLine ? ipLine.slice(3) : '').trim();
                if (isInvalidOutsideEntryIp(requestIp)) {
                    if (requestIp === '0.0.0.0') {
                        throw new Error('x trace returned invalid ip 0.0.0.0');
                    }
                    throw new Error('x trace missing ip');
                }
                return requestIp;
            }
        }
    ];

    try {
        let fastestSuccess = null;
        for (const source of testSources) {
            try {
                const requestIp = await source.getIp();
                if (isInvalidOutsideEntryIp(requestIp)) {
                    throw new Error(`${source.name} returned invalid ip`);
                }
                fastestSuccess = {
                    providerName: source.name,
                    requestIp
                };
                break;
            } catch (sourceError) {
                console.log(`[墙外测试] ${source.name} 失败: ${sourceError.message}`);
            }
        }

        if (!fastestSuccess) {
            throw new Error('all outside entry sources failed');
        }

        const fallbackIp = String(fastestSuccess.requestIp || '未知').trim() || '未知';
        setNetworkFieldValue('twitter-ip', fallbackIp, 'ip');
        clearNetworkFieldValue('twitter-country');
        applyNetworkCardFlag('twitter-country');
        renderTwitterTitle(fastestSuccess.providerName);
        renderTwitterTip(fastestSuccess.providerName);
        setStatus('status-twitter', 'loading');

        try {
            const info = await fetchIpInfoByIp(fastestSuccess.requestIp);
            const twIp = String(info.ip || fastestSuccess.requestIp || '未知').trim();
            const twLoc = formatIpInfoLocation(info);
            setNetworkFieldValue('twitter-ip', twIp, 'ip');
            setNetworkFieldValue('twitter-country', twLoc, 'location');
            applyNetworkCardFlag('twitter-country');
            setStatus('status-twitter', 'success');
            console.log(`[墙外测试] 成功: IP=${twIp}, 位置=${twLoc}, 来源=${fastestSuccess.providerName}`);
        } catch (detailError) {
            setNetworkFieldValue('twitter-country', '未知', 'location');
            applyNetworkCardFlag('twitter-country');
            setStatus('status-twitter', 'success');
            console.warn(`[墙外测试] 已获取IP=${fallbackIp}，但查询详细信息失败:`, detailError);
        }
    } catch (error) {
        setNetworkFieldError('twitter-ip', '翻墙未开启');
        clearNetworkFieldValue('twitter-country');
        applyNetworkCardFlag('twitter-country');
        setStatus('status-twitter', 'error');
        renderTwitterTitle('翻墙失败');
        renderTwitterTip('墙外站点');
        setStatus('status-twitter', 'error');
        console.error('墙外测试接口错误:', error);
    }
}

// 网络信息加载标志
let networkInfoLoaded = false;

// 加载网络信息
async function loadNetworkInfo() {
    // 检查容器是否存在
    const container = document.querySelector('.network-cards-container');
    if (!container) return;
    bindNetworkCardPrivacyToggle();

    // 设置加载标志
    networkInfoLoaded = true;

    // 并行获取所有网络信息
    await Promise.all([
        fetchIpipData(),
        fetchOverseasTestData(),
        fetchCloudFlareData(),
        fetchTwitterData()
    ]);

    // 所有网络信息加载完成后,使 IP 可点击
    setTimeout(() => {
        makeIpClickable();
    }, 500);
}

// 页面加载时自动获取网络信息（因为模块现在默认展开）
if (document.readyState !== 'loading') {
    // 页面已加载，直接加载数据
    loadNetworkInfo();
} else {
    // 页面还在加载，等待加载完成
    document.addEventListener('DOMContentLoaded', () => {
        loadNetworkInfo();
    });
}

// IP 点击查询详情功能
function makeIpClickable() {
    const ipElements = document.querySelectorAll('.ip-text');

    ipElements.forEach(element => {
        const rawIpText = String(element.dataset.rawValue || element.textContent || '').trim();

        // 跳过已经标记为错误、加载中、未知的元素
        if (element.querySelector('.error') ||
            element.dataset.displayState === 'error' ||
            rawIpText === '加载中...' ||
            rawIpText === '未知' ||
            !rawIpText ||
            element.classList.contains('clickable')) {
            return;
        }

        // 添加可点击样式
        element.classList.add('clickable');
        element.title = '点击查询IP详细信息';

        element.addEventListener('click', function (event) {
            event.stopPropagation();

            if (this.dataset.displayState !== 'ready') {
                return;
            }

            const rawIp = String(this.dataset.rawValue || this.textContent || '').trim();

            // 跳过显示"加载中..."或"未知"的元素
            if (!rawIp || rawIp === '加载中...' || rawIp === '未知') {
                return;
            }

            fetchAndShowIpDetail(rawIp, this);
        });
    });
}

// 将布尔值转换为 emoji
function boolToEmoji(value, trueEmoji = '✅', falseEmoji = '❌') {
    return value ? trueEmoji : falseEmoji;
}

// 将 IP 类型转换为中文并添加样式
function formatIpType(type) {
    if (!type) return '<span class="ip-type-unknown">未知</span>';

    const typeMap = {
        'isp': { text: '住宅', class: 'ip-type-residential' },
        'hosting': { text: '机房', class: 'ip-type-hosting' },
        'business': { text: '商用', class: 'ip-type-business' }
    };

    const typeInfo = typeMap[type.toLowerCase()] || { text: type, class: 'ip-type-unknown' };
    return `<span class="${typeInfo.class}">${typeInfo.text}</span>`;
}

// 获取威胁等级的样式类
function getThreatBadgeClass(score) {
    if (!score) return 'badge-info';

    const numScore = parseFloat(score);
    if (numScore < 0.001) return 'badge-success';
    if (numScore < 0.01) return 'badge-info';
    if (numScore < 0.1) return 'badge-warning';
    return 'badge-danger';
}

// 计算综合滥用评分
function calculateAbuseScore(companyScore, asnScore, securityFlags = {}) {
    // 如果两个分数都无效，返回null
    if (!companyScore || companyScore === '未知') companyScore = 0;
    if (!asnScore || asnScore === '未知') asnScore = 0;

    const company = parseFloat(companyScore) || 0;
    const asn = parseFloat(asnScore) || 0;

    // 计算基础评分：(company + asn) / 2 * 5
    let baseScore = ((company + asn) / 2) * 5;

    // 计算安全风险附加分：每个安全风险项增加 15%
    let riskAddition = 0;
    const riskFlags = [
        securityFlags.is_crawler,   // 爬虫
        securityFlags.is_proxy,     // 代理服务器
        securityFlags.is_vpn,       // VPN
        securityFlags.is_tor,       // Tor 网络
        securityFlags.is_abuser     // 滥用 IP
    ];

    // 统计为 true 的风险项数量
    const riskCount = riskFlags.filter(flag => flag === true).length;
    riskAddition = riskCount * 0.15; // 每个风险项增加 15%

    // 最终评分 = 基础评分 + 风险附加分
    let finalScore = baseScore + riskAddition;

    // 如果是虚假IP (蜜罐)，则风险值增加100%
    if (securityFlags.is_bogon === true) {
        finalScore += 1.0; // 增加100%
    }

    // 如果基础评分和风险附加分都是0且不是虚假IP，返回null
    if (baseScore === 0 && riskAddition === 0 && securityFlags.is_bogon !== true) return null;

    return finalScore;
}

// 获取滥用评分的颜色等级
function getAbuseScoreBadgeClass(percentage) {
    if (percentage === null || percentage === undefined) return 'badge-info';

    if (percentage >= 100) return 'badge-critical';      // 危险红色 >= 100%
    if (percentage >= 20) return 'badge-high';           // 橘黄色 15-99.99%
    if (percentage >= 5) return 'badge-elevated';     // 黄色 5-14.99%
    if (percentage >= 0.25) return 'badge-low';          // 淡绿色 0.25-4.99%
    return 'badge-verylow';                              // 绿色 < 0.25%
}

// 格式化滥用评分为百分比
function formatAbuseScorePercentage(score) {
    if (score === null || score === undefined) return '未知';

    const percentage = score * 100;
    return percentage.toFixed(2) + '%';
}

// 切换评分算法说明气泡
function toggleScoreTooltip(helpIcon) {
    const tooltip = helpIcon.nextElementSibling;
    const isShowing = tooltip.classList.contains('show');

    // 隐藏所有其他气泡
    document.querySelectorAll('.score-tooltip.show').forEach(t => {
        if (t !== tooltip) t.classList.remove('show');
    });

    // 切换当前气泡
    tooltip.classList.toggle('show');

    // 如果显示气泡，调整位置并添加点击事件监听器来关闭它
    if (!isShowing) {
        setTimeout(() => {
            positionTooltipNearMouse(tooltip, helpIcon);

            const closeTooltip = (e) => {
                if (!tooltip.contains(e.target) && !helpIcon.contains(e.target)) {
                    tooltip.classList.remove('show');
                    document.removeEventListener('click', closeTooltip);
                }
            };
            document.addEventListener('click', closeTooltip);
        }, 100);
    }
}

// 将气泡位置设置在鼠标附近
function positionTooltipNearMouse(tooltip, helpIcon) {
    const iconRect = helpIcon.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const padding = 10;

    let left = iconRect.right + padding;
    let top = iconRect.top - tooltipHeight / 2;

    // 如果气泡超出右边界，显示在左边
    if (left + tooltipWidth > windowWidth - padding) {
        left = iconRect.left - tooltipWidth - padding;
    }

    // 如果气泡超出顶部，调整到下方
    if (top < padding) {
        top = iconRect.top + padding;
    }

    // 如果气泡超出底部，调整到上方
    if (top + tooltipHeight > windowHeight - padding) {
        top = windowHeight - tooltipHeight - padding;
    }

    tooltip.style.position = 'fixed';
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
}

// 显示 IP 详情弹窗
function showIpDetailModal(data) {
    // 首先移除旧的弹窗（如果存在）
    const existingModal = document.querySelector('.ip-detail-modal');
    if (existingModal) existingModal.remove();

    // 创建弹窗
    const modal = document.createElement('div');
    modal.className = 'ip-detail-modal';

    // 计算评分和等级
    const companyScore = data.company?.abuser_score;
    const asnScore = data.asn?.abuser_score;
    const securityFlags = {
        is_crawler: data.is_crawler,
        is_proxy: data.is_proxy,
        is_vpn: data.is_vpn,
        is_tor: data.is_tor,
        is_abuser: data.is_abuser,
        is_bogon: data.is_bogon
    };

    const combinedScore = calculateAbuseScore(companyScore, asnScore, securityFlags);
    let riskControlHTML = '未知';
    let riskLevel = '未知';
    let badgeClass = 'badge-info';

    if (combinedScore !== null) {
        const scorePercentage = combinedScore * 100;
        badgeClass = getAbuseScoreBadgeClass(scorePercentage);
        const formattedScore = formatAbuseScorePercentage(combinedScore);

        if (scorePercentage >= 100) riskLevel = '极度危险';
        else if (scorePercentage >= 20) riskLevel = '高风险';
        else if (scorePercentage >= 5) riskLevel = '轻微风险';
        else if (scorePercentage >= 0.25) riskLevel = '纯净';
        else riskLevel = '极度纯净';

        riskControlHTML = `<span class="ip-detail-badge ${badgeClass}">${formattedScore} ${riskLevel}</span>`;
    }

    // 构建 HTML 结构
    modal.innerHTML = `
        <div class="ip-detail-content">
            <div class="ip-detail-header">
                <h2 class="ip-detail-title">
                    🔍 IP 详细信息
                    <span class="ip-detail-source-tag">数据来源: ipapi.is</span>
                </h2>
                <button class="ip-detail-close" title="关闭">&times;</button>
            </div>
            <div class="ip-detail-body">
                <!-- 地图展示区 -->
                <div class="ip-detail-map-container">
                    <div id="ip-detail-map"></div>
                </div>

                <!-- 数据网格区 -->
                <div class="ip-detail-grid-container">
                    <!-- 左栏: 基本信息 (整合地理、运营商信息) -->
                    <div class="ip-detail-left-col">
                        <div class="ip-detail-card" style="height: 100%;">
                            <div class="ip-detail-section-title">📍 基本信息</div>
                            <div class="ip-detail-item" title="当前查询的公网 IP 地址，用于在互联网上唯一标识设备">
                                <span class="ip-detail-label">IP 地址</span>
                                <span class="ip-detail-value">${data.ip || '未知'}</span>
                            </div>
                            <div class="ip-detail-item" title="IP 地址的物理位置，通过 IP 地址段分配数据库推算得出，包括国家/地区、州省和城市信息">
                                <span class="ip-detail-label">地理位置</span>
                                <span class="ip-detail-value">${data.location?.country_code ? `[${data.location.country_code}]` : ''}${data.location?.country || ''} ${[data.location?.state, data.location?.city].filter(Boolean).join('/') || '未知'}</span>
                            </div>
                            <div class="ip-detail-item" title="该 IP 地址所在地区使用的标准时区，格式为洲/城市，如 Asia/Shanghai">
                                <span class="ip-detail-label">时区</span>
                                <span class="ip-detail-value">${data.location?.timezone || '未知'}</span>
                            </div>
                            <div class="ip-detail-item" title="IP 的网络类型:【住宅】家庭宽带、【机房】数据中心或云服务器、【商用】企业专线。左侧为运营商分类，右侧为 ASN (自治系统)分类">
                                <span class="ip-detail-label">运营商 / ASN 类型</span>
                                <span class="ip-detail-value">${formatIpType(data.company?.type)} / ${formatIpType(data.asn?.type)}</span>
                            </div>
                            <div class="ip-detail-item" title="综合滥用评分，基于运营商/ASN 历史记录和安全风险项计算。评分越低表示 IP 越纯净，越高表示被滥用可能性越大">
                                <span class="ip-detail-label">风控评级</span>
                                <span class="ip-detail-value">${riskControlHTML}</span>
                            </div>
                        </div>
                    </div>

                    <!-- 右栏: 安全检测 -->
                    <div class="ip-detail-right-col">
                        <!-- 安全检测内容保持不变 -->
                        <div class="ip-detail-card" style="height: 100%;">
                            <div class="ip-detail-section-title">🛡️ 安全检测</div>
                            <div class="ip-detail-security-grid">
                                <div class="ip-detail-item" title="该 IP 是否属于数据中心(IDC)、云服务商或主机托管服务。数据中心 IP 常被用于服务器部署，部分网站可能限制此类 IP 访问">
                                    <span class="ip-detail-label">数据中心</span>
                                    <span class="ip-detail-value">${data.is_datacenter ? '<span class="warning-text">🏢 是</span>' : '✅ 否'}</span>
                                </div>
                                <div class="ip-detail-item" title="该 IP 是否被识别为公开的代理服务器(如 HTTP/SOCKS 代理)。代理服务器可能被用于隐藏真实 IP，部分服务会限制代理访问">
                                    <span class="ip-detail-label">代理服务器</span>
                                    <span class="ip-detail-value">${data.is_proxy ? '<span class="danger-text">⚠️ 是</span>' : '✅ 否'}</span>
                                </div>
                                <div class="ip-detail-item" title="该 IP 是否属于已知的 VPN (虚拟私人网络)服务提供商。VPN 用于加密网络流量和隐藏真实位置，部分网站会限制 VPN 访问">
                                    <span class="ip-detail-label">VPN 连线</span>
                                    <span class="ip-detail-value">${data.is_vpn ? '<span class="danger-text">⚠️ 是</span>' : '✅ 否'}</span>
                                </div>
                                <div class="ip-detail-item" title="该 IP 是否属于 Tor (洋葱路由)匿名网络的出口节点。Tor 提供高度匿名性，但也常被用于非法活动，因此大多数网站会限制或禁止 Tor 访问">
                                    <span class="ip-detail-label">Tor 网络</span>
                                    <span class="ip-detail-value">${data.is_tor ? '<span class="danger-text">⚠️ 是</span>' : '✅ 否'}</span>
                                </div>
                                <div class="ip-detail-item" title="该 IP 是否被识别为网络爬虫(搜索引擎蜘蛛、数据采集机器人等)。爬虫可能对网站造成额外负担，部分网站会限制或特殊处理爬虫流量">
                                    <span class="ip-detail-label">网络爬虫</span>
                                    <span class="ip-detail-value">${data.is_crawler ? '<span class="danger-text">🤖 是</span>' : '✅ 否'}</span>
                                </div>
                                <div class="ip-detail-item" title="该 IP 是否来自移动网络运营商(如 4G/5G 网络)。移动网络 IP 通常动态分配且更换频繁，属于住宅类 IP">
                                    <span class="ip-detail-label">移动网络</span>
                                    <span class="ip-detail-value">${data.is_mobile ? '<span class="success-text">📱 是</span>' : '否'}</span>
                                </div>
                                <div class="ip-detail-item" title="该 IP 是否来自卫星互联网服务(如 Starlink、OneWeb 等)。卫星网络通常用于偏远地区或移动场景的互联网接入，延迟较高">
                                    <span class="ip-detail-label">卫星网络</span>
                                    <span class="ip-detail-value">${data.is_satellite ? '<span class="success-text">🛰️ 是</span>' : '否'}</span>
                                </div>
                                <div class="ip-detail-item" title="该 IP 是否存在已知的滥用记录(如垃圾邮件、DDoS 攻击、恶意扫描等)。滥用 IP 通常会被安全系统拦截或限制访问">
                                    <span class="ip-detail-label">已知滥用</span>
                                    <span class="ip-detail-value">${data.is_abuser ? '<span class="danger-text">⚠️ 是</span>' : '✅ 否'}</span>
                                </div>
                                <div class="ip-detail-item" title="该 IP 是否为虚假 IP (Bogon IP)，即保留地址、私有地址或未分配的地址段。此类 IP 不应出现在公网上，可能表示异常流量或蜜罐">
                                    <span class="ip-detail-label">虚假 IP</span>
                                    <span class="ip-detail-value">${data.is_bogon ? '<span class="danger-text">⚠️ 是</span>' : '✅ 否'}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // 初始化弹窗内的地图
    if (data.location?.latitude && data.location?.longitude) {
        const lat = parseFloat(data.location.latitude);
        const lng = parseFloat(data.location.longitude);

        // 给 DOM 渲染留出一点点时间
        setTimeout(() => {
            await loadLeaflet();
                    const detailMap = L.map('ip-detail-map', {
                zoomControl: false,
                attributionControl: false
            }).setView([lat + 5, lng], 4); // 向上偏移中心点，使标记在视野内偏下

            L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
                subdomains: '1234',
                minZoom: 1,
                maxZoom: 18
            }).addTo(detailMap);

            const popupHTML = `
                <div class="ip-detail-popup-content">
                    <div class="ip-detail-popup-city">
                        ${data.location?.city || data.location?.country || '位置'}
                    </div>
                    <div class="ip-detail-popup-item">
                        <span class="ip-detail-popup-label">国家:</span>
                        <span class="ip-detail-popup-value">[${data.location?.country_code || '-'}]${data.location?.country || '未知'}</span>
                    </div>
                    <div class="ip-detail-popup-item">
                        <span class="ip-detail-popup-label">落地IP:</span>
                        <span class="ip-detail-popup-value">${data.ip}</span>
                    </div>
                    <div class="ip-detail-popup-item">
                        <span class="ip-detail-popup-label">ASN:</span>
                        <span class="ip-detail-popup-value">${data.asn?.asn || ''}</span>
                    </div>
                    <div class="ip-detail-popup-item">
                        <span class="ip-detail-popup-label">运营商:</span>
                        <span class="ip-detail-popup-value">${data.company?.name || '未知'}</span>
                    </div>
                </div>
            `;

            L.marker([lat, lng])
                .addTo(detailMap)
                .bindPopup(popupHTML, { closeButton: false, offset: [0, -32] })
                .openPopup();

            // 偶尔地图布局会出问题，强制刷新
            detailMap.invalidateSize();
        }, 400);
    } else {
        // 如果没有经纬度，隐藏地图容器
        const mapContainer = modal.querySelector('.ip-detail-map-container');
        if (mapContainer) mapContainer.style.display = 'none';
    }

    // 关闭逻辑
    const closeBtn = modal.querySelector('.ip-detail-close');
    const closeFunc = () => {
        modal.style.opacity = '0';
        modal.querySelector('.ip-detail-content').style.transform = 'translateY(20px)';
        setTimeout(() => modal.remove(), 300);
    };

    closeBtn.onclick = closeFunc;
    modal.onclick = (e) => { if (e.target === modal) closeFunc(); };

    // ESC 键关闭
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closeFunc();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}

// ==================== 获取更多 PROXYIP 相关函数 ====================

function showGetMoreProxyIPModal() {
    showExploreProxyModal('proxyip');
    // 重置已选
    selectedProxyIPs = [];
    updateSelectedProxyIPsUI();
}

function closeGetMoreProxyIPModal(event) {
    closeExploreProxyModal('proxyip', event);
}

function onProxyIPDataRegionChange() {
    onProxyRegionChange('proxyip');
}

async function verifySingleProxyIP(proxy, signal) {
    const config = proxyConfigs['proxyip'];
    const proxyIp = proxy.proxy; // format: ip

    if (signal && signal.aborted) return;

    // 设置15秒超时
    const timeoutId = setTimeout(() => {
        window[config.verificationStatus][proxyIp] = {
            status: 'timeout',
            responseTime: null
        };
        updateProxyDisplay('proxyip');
    }, 10000);

    window[config.verificationTimeouts][proxyIp] = timeoutId;

    try {
        const response = await fetch(`https://api.090227.xyz/check?proxyip=${proxyIp}`, { signal });
        clearTimeout(window[config.verificationTimeouts][proxyIp]);

        if (response.ok) {
            const data = await response.json();
            if (data.success) {
                window[config.verificationStatus][proxyIp] = {
                    status: 'success',
                    responseTime: data.responseTime,
                    supports_ipv4: data.supports_ipv4 === true,
                    supports_ipv6: data.supports_ipv6 === true
                };
            } else {
                window[config.verificationStatus][proxyIp] = {
                    status: 'failed',
                    responseTime: null
                };
            }
        } else {
            window[config.verificationStatus][proxyIp] = {
                status: 'failed',
                responseTime: null
            };
        }
    } catch (error) {
        if (signal && signal.aborted) return;
        window[config.verificationStatus][proxyIp] = {
            status: 'failed',
            responseTime: null
        };
    }
    updateProxyDisplay('proxyip');
}

function addSelectedProxyIP() {
    const select = document.getElementById('proxyIPProxySelect');
    const ip = select.value;
    if (!ip) return;

    if (selectedProxyIPs.length >= 8) {
        showToast('最多只能选择 8 个 ProxyIP', 'warning');
        return;
    }

    if (selectedProxyIPs.includes(ip)) {
        showToast('该 IP 已在选择列表中', 'warning');
        return;
    }

    selectedProxyIPs.push(ip);
    updateSelectedProxyIPsUI();
    updateProxyIPConfirmButton();
}

function removeSelectedProxyIP(ip) {
    selectedProxyIPs = selectedProxyIPs.filter(item => item !== ip);
    updateSelectedProxyIPsUI();
    updateProxyIPConfirmButton();
}

function updateSelectedProxyIPsUI() {
    const container = document.getElementById('selectedProxyIPsContainer');
    container.innerHTML = '';

    selectedProxyIPs.forEach(ip => {
        // 查找对应的国家 emoji
        const dataList = window.proxyIPListData || [];
        const proxyData = dataList.find(p => p.ip === ip);
        const emoji = proxyData?.country_emoji || '🌐';

        // 构建 title 信息
        let titleText = '';
        if (proxyData) {
            const city = proxyData.city || '未知';
            const country = proxyData.country || '未知';
            const countryName = proxyData.country_cn || '未知';
            const clientIp = proxyData.clientIp || ip;
            const asn = proxyData.asn || '未知';
            const asOrganization = proxyData.asOrganization || '未知';

            titleText = `${city}\n国家: [${country}]${countryName}\n落地IP: ${clientIp}\nASN: ${asn}\n运营商: ${asOrganization}`;
        }

        const tag = document.createElement('div');
        tag.style.cssText = 'background: #fee2e2; border: 1px solid #ef4444; color: #b91c1c; padding: 4px 10px; border-radius: 9999px; display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500;';
        if (titleText) {
            tag.title = titleText;
        }
        tag.innerHTML = `
            <span>${emoji} ${ip}</span>
            <span onclick="removeSelectedProxyIP('${ip}')" style="cursor: pointer; font-weight: bold; font-size: 16px;">×</span>
        `;
        container.appendChild(tag);
    });
}

function updateProxyIPConfirmButton() {
    const btn = document.getElementById('proxyIPConfirmBtn');
    btn.disabled = selectedProxyIPs.length === 0;
}

function confirmSelectProxyIP() {
    const input = document.getElementById('proxyIP');
    if (input) {
        input.value = selectedProxyIPs.join(',');
        input.dispatchEvent(new Event('change', { bubbles: true }));
        markModified('proxy');
    }

    closeGetMoreProxyIPModal();

    // 如果勾选了自动获取，取消勾选
    const autoProxyCheck = document.getElementById('autoProxy');
    if (autoProxyCheck && autoProxyCheck.checked) {
        autoProxyCheck.checked = false;
        if (typeof toggleAutoProxy === 'function') toggleAutoProxy();
    }

    const config = proxyConfigs['proxyip'];
    if (config.abortController) {
        config.abortController.abort();
        config.abortController = null;
    }

    // 亮起保存和取消按钮
    const saveBtn = document.getElementById('saveProxyBtn');
    const cancelBtn = document.getElementById('cancelProxyBtn');
    if (saveBtn) saveBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
}

// ==================== SOCKS5 相关函数 ====================

// 代理类型配置
const proxyConfigs = {
    socks5: {
        modalId: 'exploreSocks5Modal',
        regionSelectId: 'socks5RegionSelect',
        proxySelectId: 'socks5ProxySelect',
        proxySelectGroupId: 'socks5ProxySelectGroup',
        confirmBtnId: 'socks5ConfirmBtn',
        listData: 'socks5ListData',
        countryMap: 'socks5CountryMap',
        verificationStatus: 'socks5VerificationStatus',
        verificationTimeouts: 'socks5VerificationTimeouts',
        url: 'https://raw.githubusercontent.com/EDT-Pages/Proxy-List/main/data/socks5.json',
        description: 'SOCKS5列表',
        inputId: 'socks5Addr',
        abortController: null,
        verifySingleFunction: (proxy, signal) => verifySingleProxy(proxy, 'socks5', signal)
    },
    http: {
        modalId: 'exploreHTTPModal',
        regionSelectId: 'httpRegionSelect',
        proxySelectId: 'httpProxySelect',
        proxySelectGroupId: 'httpProxySelectGroup',
        confirmBtnId: 'httpConfirmBtn',
        listData: 'httpListData',
        countryMap: 'httpCountryMap',
        verificationStatus: 'httpVerificationStatus',
        verificationTimeouts: 'httpVerificationTimeouts',
        url: 'https://raw.githubusercontent.com/EDT-Pages/Proxy-List/main/data/http.json',
        description: 'HTTP列表',
        inputId: 'httpAddr',
        abortController: null,
        verifySingleFunction: (proxy, signal) => verifySingleProxy(proxy, 'http', signal)
    },
    https: {
        modalId: 'exploreHTTPSModal',
        regionSelectId: 'httpsRegionSelect',
        proxySelectId: 'httpsProxySelect',
        proxySelectGroupId: 'httpsProxySelectGroup',
        confirmBtnId: 'httpsConfirmBtn',
        listData: 'httpsListData',
        countryMap: 'httpsCountryMap',
        verificationStatus: 'httpsVerificationStatus',
        verificationTimeouts: 'httpsVerificationTimeouts',
        url: 'https://raw.githubusercontent.com/EDT-Pages/Proxy-List/main/data/https.json',
        description: 'HTTPS列表',
        inputId: 'httpsAddr',
        abortController: null,
        verifySingleFunction: (proxy, signal) => verifySingleProxy(proxy, 'https', signal)
    },
    proxyip: {
        modalId: 'getMoreProxyIPModal',
        regionSelectId: 'proxyIPDataRegionSelect',
        proxySelectId: 'proxyIPProxySelect',
        proxySelectGroupId: 'proxyIPProxySelectGroup',
        confirmBtnId: 'proxyIPConfirmBtn',
        listData: 'proxyIPListData',
        countryMap: 'proxyIPCountryMap',
        verificationStatus: 'proxyIPVerificationStatus',
        verificationTimeouts: 'proxyIPVerificationTimeouts',
        url: 'https://zip.cm.edu.kg/all.json',
        description: 'ProxyIP列表',
        inputId: 'proxyIP',
        abortController: null,
        verifySingleFunction: (proxy, signal) => verifySingleProxyIP(proxy, signal)
    }
};

// 存储SOCKS5数据
let socks5ListData = [];
let socks5CountryMap = {};
let socks5VerificationStatus = {}; // 存储验证状态
let socks5VerificationTimeouts = {}; // 存储超时计时器

// 存储 ProxyIP 数据
let proxyIPListData = [];
let proxyIPCountryMap = {};
let proxyIPVerificationStatus = {};
let proxyIPVerificationTimeouts = {};
let selectedProxyIPs = []; // 存储用户选择的 ProxyIP

function showExploreSocks5Modal() {
    showExploreProxyModal('socks5');
}

function closeExploreSocks5Modal(event) {
    closeExploreProxyModal('socks5', event);
}

function loadSocks5List() {
    loadProxyList('socks5');
}

function buildCountryMap(listData, countryMap) {
    countryMap = {};

    // 统计每个国家的代理数量
    listData.forEach(item => {
        const country = item.country;
        if (!countryMap[country]) {
            countryMap[country] = [];
        }
        countryMap[country].push(item);
    });

    // 按数量排序（多到少）
    countryMap = Object.fromEntries(
        Object.entries(countryMap).sort((a, b) => b[1].length - a[1].length)
    );

    return countryMap;
}

function populateSocks5RegionSelect() {
    populateProxyRegionSelect('socks5');
}

function onSocks5RegionChange() {
    onProxyRegionChange('socks5');
}

function populateSocks5ProxySelect(selectedCountry) {
    populateProxySelect(selectedCountry, 'socks5ProxySelect', socks5CountryMap, socks5VerificationStatus, 'socks5');
}

function verifySocks5Proxies(proxies) {
    verifyProxies(proxies, verifySingleSocks5);
}

function verifySingleSocks5(proxy, signal) {
    return verifySingleProxy(proxy, 'socks5', signal);
}

function updateSocks5Display() {
    updateProxyDisplay('socks5');
}

function confirmSelectSocks5() {
    confirmSelectProxy('socks5');
}

function updateSocks5ConfirmButton() {
    updateProxyConfirmButton('socks5');
}

// 通用代理选择器填充函数
function populateProxySelect(selectedCountry, selectId, countryMap, verificationStatus, type) {
    const select = document.getElementById(selectId);
    const proxies = countryMap[selectedCountry] || [];

    // 保存当前选中的值
    const currentValue = select.value;

    // 检查是否所有代理都验证完成
    const allVerified = proxies.every(p => {
        const status = verificationStatus[p.proxy];
        return status && status.status !== 'pending';
    });

    // 获取当前地区的所有代理，并按状态和延迟排序
    const sortedProxies = [...proxies].sort((a, b) => {
        const statusA = verificationStatus[a.proxy] || { status: 'pending' };
        const statusB = verificationStatus[b.proxy] || { status: 'pending' };

        // 可用的在前面，且按延迟从低到高
        if (statusA.status === 'success' && statusB.status === 'success') {
            return (statusA.responseTime || 0) - (statusB.responseTime || 0);
        }
        if (statusA.status === 'success') return -1;
        if (statusB.status === 'success') return 1;

        return 0;
    });

    // 检查是否有成功的代理
    const successfulProxies = sortedProxies.filter(proxy => verificationStatus[proxy.proxy]?.status === 'success');

    // 辅助函数：生成代理选项HTML
    function generateProxyOption(proxy, isSelectable = false) {
        const status = verificationStatus[proxy.proxy] || { status: 'pending' };
        let emoji = '⏳';
        let statusText = '验证中';

        if (status.status === 'success') {
            if (type === 'proxyip') {
                const supportsV4 = status.supports_ipv4 === true;
                const supportsV6 = status.supports_ipv6 === true;

                if (supportsV4 && supportsV6) {
                    emoji = '✅✅';
                } else if (supportsV4 && !supportsV6) {
                    emoji = '✅🔴';
                } else if (!supportsV4 && supportsV6) {
                    emoji = '🔴✅';
                } else {
                    emoji = '🔴🔴';
                }
            } else {
                emoji = '✅';
            }
            statusText = `${status.responseTime}ms`;
        } else if (status.status === 'timeout') {
            emoji = '🔴';
            statusText = '已超时';
        } else if (status.status === 'failed') {
            emoji = '🔴';
            statusText = '不可用';
        }

        // ProxyIP 模式下 label 稍微不同，不包含协议前缀
        const label = type === 'proxyip'
            ? `${emoji}[${statusText}]${proxy.ip}${proxy.city ? ` - ${proxy.city}` : ''},AS${proxy.asn}`
            : `${emoji}[${statusText}]${proxy.city},AS${proxy.asn},${proxy.asOrganization}`;

        const disabled = !isSelectable || status.status !== 'success';
        // ProxyIP 不需要默认选中，因为是多选触发
        const selected = type !== 'proxyip' && isSelectable && status.status === 'success' && successfulProxies.indexOf(proxy) === 0 ? 'selected' : '';
        return `<option value="${proxy.proxy}" ${disabled ? 'disabled' : ''} ${selected}>${label}</option>`;
    }

    let html = type === 'proxyip' ? '<option value="">-- 请选择代理 --</option>' : '';
    if (successfulProxies.length > 0) {
        // 有成功的代理，显示所有代理
        sortedProxies.forEach(proxy => {
            html += generateProxyOption(proxy, true);
        });
    } else if (allVerified) {
        // 验证完成但没有成功的代理
        html = '<option value="">很抱歉，当前地区无可用代理，请切换其他地区。</option>';
    } else {
        // 验证中，显示代理列表
        html = (type === 'proxyip' ? '<option value="">正在验证可用性，请稍候...</option>' : '<option value="">正在验证可用性，请稍候...</option>');
        sortedProxies.forEach(proxy => {
            html += generateProxyOption(proxy, false);
        });
    }

    select.innerHTML = html;

    // 恢复用户的选择 (ProxyIP 模式下如果当前选中的仍然有效，也恢复)
    if (successfulProxies.length > 0) {
        if (currentValue && successfulProxies.some(p => p.proxy === currentValue)) {
            select.value = currentValue;
        } else if (type !== 'proxyip') {
            select.value = successfulProxies[0].proxy;
        }
    }
}

// 通用代理验证函数
// Fisher-Yates 打乱算法 - 随机打乱数组顺序
function shuffleArray(array) {
    const shuffled = [...array]; // 创建副本，不修改原数组
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        // 交换元素
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function verifyProxies(proxies, verifySingleFunction, onProgress, signal) {
    // 打乱代理列表的顺序，避免多个用户同时测试时都从头开始
    const shuffledProxies = shuffleArray(proxies);

    // 并发控制：最多8个并发请求
    const maxConcurrent = 8;
    let currentIndex = 0;
    let activeRequests = 0;

    function startNextProxy() {
        if (signal && signal.aborted) return;
        if (currentIndex >= shuffledProxies.length || activeRequests >= maxConcurrent) {
            return;
        }

        activeRequests++;
        const proxy = shuffledProxies[currentIndex++];

        verifySingleFunction(proxy, signal).finally(() => {
            activeRequests--;
            if (onProgress) onProgress();
            startNextProxy();
        });
    }

    // 启动初始8个请求
    for (let i = 0; i < Math.min(maxConcurrent, shuffledProxies.length); i++) {
        startNextProxy();
    }
}

// 通用代理探索函数
function showExploreProxyModal(type) {
    const config = proxyConfigs[type];
    const modal = document.getElementById(config.modalId);
    if (!modal) return;

    // 重置状态
    window[config.listData] = [];
    window[config.countryMap] = {};
    window[config.verificationStatus] = {};
    window[config.verificationTimeouts] = {};
    lastMappedProxy[type] = null;

    modal.classList.add('show');
    document.getElementById(config.regionSelectId).innerHTML = '<option value="">加载中...</option>';
    document.getElementById(config.proxySelectGroupId).style.display = 'block';
    document.getElementById(config.confirmBtnId).disabled = true;

    // 初始化下拉框 focus/blur 监听（首次生效）
    ensureProxySelectListeners(type);
    // 重置节流状态
    resetProxyDisplayUpdateState(type);

    // 加载列表
    loadProxyList(type);

    // 初始化或更新地图容器
    setTimeout(() => {
        initProxyMap(type);
    }, 300);
}

const lastMappedProxy = {
    socks5: null,
    http: null,
    https: null,
    proxyip: null
};

const proxyMaps = {
    socks5: { map: null, marker: null },
    http: { map: null, marker: null },
    https: { map: null, marker: null },
    proxyip: { map: null, marker: null }
};

async function initProxyMap(type) {
            try { await loadLeaflet(); } catch(e) { console.error("Leaflet load failed:", e); return; }
    const containerId = type === 'socks5' ? 'proxy-map-socks5' : (type === 'http' ? 'proxy-map-http' : (type === 'https' ? 'proxy-map-https' : 'proxy-map-proxyip'));
    const container = document.getElementById(containerId);
    if (!container) return;

    // 如果地图已存在，先刷新布局
    if (proxyMaps[type] && proxyMaps[type].map) {
        proxyMaps[type].map.invalidateSize();
        return;
    }

    if (!proxyMaps[type]) proxyMaps[type] = { map: null, marker: null };

    // 创建地图
    const map = L.map(containerId, {
        zoomControl: false, // 隐藏缩放控制，让界面更清爽
        attributionControl: false
    }).setView([22.2783, 114.1747], 4);

    L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
        subdomains: '1234',
        minZoom: 1,
        maxZoom: 18
    }).addTo(map);

    proxyMaps[type].map = map;
}

function updateProxyMap(type) {
    const config = proxyConfigs[type];
    const select = document.getElementById(config.proxySelectId);
    const selectedProxyUrl = select.value;
    if (!selectedProxyUrl || !proxyMaps[type].map) return;

    // 如果该代理已经显示在地图上了，就不再重复加载，避免频繁刷新导致的气泡闪烁
    if (lastMappedProxy[type] === selectedProxyUrl) return;
    lastMappedProxy[type] = selectedProxyUrl;

    // 从数据列表中找到完整的代理信息
    const proxyData = window[config.listData].find(p => p.proxy === selectedProxyUrl);
    if (!proxyData || proxyData.latitude === null || proxyData.longitude === null) return;

    const lat = parseFloat(proxyData.latitude);
    const lng = parseFloat(proxyData.longitude);
    const map = proxyMaps[type].map;

    // 更新或创建 Marker
    if (proxyMaps[type].marker) {
        proxyMaps[type].marker.setLatLng([lat, lng]);
    } else {
        proxyMaps[type].marker = L.marker([lat, lng]).addTo(map);
    }

    // 平滑移动地图 - 将标记点定位到地图的下方60%位置，避免气泡被遮挡
    map.setZoom(4);

    // 计算偏移后的中心点，使标记显示在视图的60%处（下方）
    const mapSize = map.getSize();
    const offsetY = mapSize.y * 0.2; // 向上偏移20%，使标记显示在60%处
    const point = map.project([lat, lng], 4).subtract([0, offsetY]);
    const offsetCenter = map.unproject(point, 4);

    if (isLowPerformanceMode) {
        map.setView(offsetCenter, 4, { animate: false });
    } else {
        map.flyTo(offsetCenter, 4, {
            duration: 1.5
        });
    }

    // 添加或更新 Popup
    const isDark = document.documentElement.classList.contains('dark-mode');
    const textColor = isDark ? '#ffffff' : '#333333';
    const popupContent = `
        <div class="ip-detail-popup-city">
            ${proxyData.city || proxyData.country || '位置'}
        </div>
        <div class="ip-detail-popup-item">
            <span class="ip-detail-popup-label">国家:</span>
            <span class="ip-detail-popup-value">[${proxyData.country || '-'}]${proxyData.country_cn || ''}</span>
        </div>
        <div class="ip-detail-popup-item">
            <span class="ip-detail-popup-label">落地IP:</span>
            <span class="ip-detail-popup-value">${proxyData.clientIp || proxyData.ip || '-'}</span>
        </div>
        <div class="ip-detail-popup-item">
            <span class="ip-detail-popup-label">ASN:</span>
            <span class="ip-detail-popup-value">${proxyData.asn || ''}</span>
        </div>
        <div class="ip-detail-popup-item">
            <span class="ip-detail-popup-label">运营商:</span>
            <span class="ip-detail-popup-value">${proxyData.asOrganization || '未知'}</span>
        </div>
    `;
    proxyMaps[type].marker.bindPopup(popupContent, { offset: L.point(0, -32) }).openPopup();
}

function closeExploreProxyModal(type, event) {
    if (event && event.preventDefault) event.preventDefault();
    const config = proxyConfigs[type];
    const modal = document.getElementById(config.modalId);
    if (modal) {
        modal.classList.remove('show');
    }

    // 停止正在进行的测试
    if (config.abortController) {
        config.abortController.abort();
        config.abortController = null;
    }

    // 清除所有超时计时器
    for (let timeout of Object.values(window[config.verificationTimeouts])) {
        clearTimeout(timeout);
    }

    // 清理节流定时器
    resetProxyDisplayUpdateState(type);
}

function loadProxyList(type) {
    const config = proxyConfigs[type];
    const url = config.url;

    fetchWithAutoMirror(url, config.description)
        .then(text => {
            let data = JSON.parse(text);
            if (type === 'proxyip') {
                // all.json format has a 'data' array
                data = data.data.filter(item =>
                    Array.isArray(item.port) ? item.port.includes(443) : item.port === 443
                ).map(item => ({
                    proxy: item.ip,
                    ip: item.ip,
                    country: item.meta?.country || 'Unknown',
                    country_cn: item.meta?.country_cn || '未知',
                    country_en: item.meta?.country_en || 'Unknown',
                    country_emoji: item.meta?.country_emoji || '🏳️',
                    city: item.meta?.city || '未知',
                    clientIp: item.meta?.clientIp || item.ip,
                    asn: item.meta?.asn || 0,
                    asOrganization: item.meta?.asOrganization || '未知',
                    continent: item.meta?.continent || 'Unknown',
                    latitude: item.meta?.latitude !== undefined ? item.meta.latitude : (item.meta?.colo?.lat !== undefined ? item.meta.colo.lat : null),
                    longitude: item.meta?.longitude !== undefined ? item.meta.longitude : (item.meta?.colo?.lon !== undefined ? item.meta.colo.lon : null)
                }));
            }
            window[config.listData] = data;
            window[config.countryMap] = buildCountryMap(window[config.listData], window[config.countryMap]);
            populateProxyRegionSelect(type);
        })
        .catch(error => {
            console.error(`${config.description}加载失败:`, error);
            document.getElementById(config.regionSelectId).innerHTML = '<option value="">加载失败</option>';
        });
}

// 大洲信息映射
const continentInfo = {
    'AS': { emoji: '🌏', name: '亚洲' },
    'NA': { emoji: '🌎', name: '北美' },
    'EU': { emoji: '🌍', name: '欧洲' },
    'AF': { emoji: '🌍', name: '非洲' },
    'SA': { emoji: '🌎', name: '南美' },
    'OC': { emoji: '🌏', name: '大洋洲' },
    'AN': { emoji: '❄️', name: '南极洲' }
};

function populateProxyRegionSelect(type) {
    const config = proxyConfigs[type];
    const select = document.getElementById(config.regionSelectId);
    let html = '<option value="">-- 请选择地区 --</option>';

    // 构建按大洲分组的结构
    const continentMap = {};

    // 遍历所有国家，归类到大洲
    for (const [country, proxies] of Object.entries(window[config.countryMap])) {
        const proxy = proxies[0]; // 取第一个代理获取大洲信息
        const continent = proxy.continent || 'Unknown';
        const continentData = continentInfo[continent] || { emoji: '🌍', name: continent };

        if (!continentMap[continent]) {
            continentMap[continent] = {
                emoji: continentData.emoji,
                name: continentData.name,
                countries: {}
            };
        }

        continentMap[continent].countries[country] = {
            count: proxies.length,
            name: proxy.country_cn || country,
            emoji: proxy.country_emoji || ''
        };
    }

    // 生成 HTML
    for (const [continentCode, continentData] of Object.entries(continentMap)) {
        const label = `${continentData.emoji} ${continentData.name} / ${continentCode}`;
        html += `<optgroup label="${label}">`;

        for (const [country, countryData] of Object.entries(continentData.countries)) {
            html += `<option value="${country}">${countryData.emoji} ${countryData.name}(${countryData.count})</option>`;
        }

        html += `</optgroup>`;
    }

    select.innerHTML = html;
}

function onProxyRegionChange(type) {
    const config = proxyConfigs[type];
    const selectedCountry = document.getElementById(config.regionSelectId).value;

    if (!selectedCountry) {
        document.getElementById(config.confirmBtnId).disabled = true;
        return;
    }

    const proxies = window[config.countryMap][selectedCountry] || [];

    // 显示代理选择组
    document.getElementById(config.proxySelectGroupId).style.display = 'block';

    // 初始化每个代理的验证状态
    proxies.forEach(proxy => {
        if (!window[config.verificationStatus][proxy.proxy]) {
            window[config.verificationStatus][proxy.proxy] = {
                status: 'pending', // pending, success, failed, timeout
                responseTime: null
            };
        }
    });

    // 设置select为验证中状态
    const select = document.getElementById(config.proxySelectId);
    select.innerHTML = '<option value="">正在验证可用性，请稍候...</option>';

    // 显示代理列表
    populateProxySelect(selectedCountry, config.proxySelectId, window[config.countryMap], window[config.verificationStatus]);

    // 释放之前的 AbortController 并创建新的
    if (config.abortController) {
        config.abortController.abort();
    }
    config.abortController = new AbortController();

    // 开始验证所有代理
    verifyProxies(proxies, config.verifySingleFunction, () => {
        updateProxyDisplay(type);
        // 如果当前选中的是成功的，尝试更新地图
        updateProxyMap(type);
    }, config.abortController.signal);
}

// ===== 节流更新系统：避免移动端下拉框被频繁刷新 =====
const PROXY_DISPLAY_UPDATE_INTERVAL = 6000; // 节流间隔：6秒
const proxyDisplayUpdateState = {
    socks5: { lastUpdate: 0, pending: false, timer: null, selectOpen: false, listenersAdded: false },
    http: { lastUpdate: 0, pending: false, timer: null, selectOpen: false, listenersAdded: false },
    https: { lastUpdate: 0, pending: false, timer: null, selectOpen: false, listenersAdded: false },
    proxyip: { lastUpdate: 0, pending: false, timer: null, selectOpen: false, listenersAdded: false }
};

// 为代理选择下拉框添加 focus/blur 监听，检测用户是否正在操作下拉框
function ensureProxySelectListeners(type) {
    const state = proxyDisplayUpdateState[type];
    if (state.listenersAdded) return;
    const config = proxyConfigs[type];
    const select = document.getElementById(config.proxySelectId);
    if (!select) return;
    select.addEventListener('focus', () => {
        state.selectOpen = true;
    });
    select.addEventListener('blur', () => {
        state.selectOpen = false;
        // 下拉框关闭时，如果有待处理的更新立即执行
        if (state.pending) {
            _doUpdateProxyDisplay(type);
        }
    });
    state.listenersAdded = true;
}

// 检查当前地区所有代理是否全部验证完成
function isAllProxiesVerified(type) {
    const config = proxyConfigs[type];
    const selectedCountry = document.getElementById(config.regionSelectId).value;
    if (!selectedCountry) return false;
    const proxies = window[config.countryMap][selectedCountry] || [];
    return proxies.length > 0 && proxies.every(p => {
        const s = window[config.verificationStatus][p.proxy];
        return s && s.status !== 'pending';
    });
}

// 节流版 updateProxyDisplay —— 外部统一调用此函数
// 策略：下拉框关闭时实时更新；下拉框打开时每 6 秒节流更新一次
function updateProxyDisplay(type) {
    const state = proxyDisplayUpdateState[type];
    const now = Date.now();

    // 下拉框未打开：直接实时更新
    if (!state.selectOpen) {
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        _doUpdateProxyDisplay(type);
        return;
    }

    // === 以下为下拉框打开状态的节流逻辑 ===

    // 全部验证完成时强制安排一次更新（最终结果）
    if (isAllProxiesVerified(type)) {
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        // 距上次更新已超过节流间隔，直接更新
        if (now - state.lastUpdate >= PROXY_DISPLAY_UPDATE_INTERVAL) {
            _doUpdateProxyDisplay(type);
        } else {
            // 未到间隔，安排一个定时器确保最终结果会被刷新
            state.pending = true;
            if (!state.timer) {
                const delay = PROXY_DISPLAY_UPDATE_INTERVAL - (now - state.lastUpdate);
                state.timer = setTimeout(() => {
                    state.timer = null;
                    if (state.pending) {
                        _doUpdateProxyDisplay(type);
                    }
                }, delay);
            }
        }
        return;
    }

    // 节流：距上次更新不到 6 秒，延迟执行
    if (now - state.lastUpdate < PROXY_DISPLAY_UPDATE_INTERVAL) {
        state.pending = true;
        if (!state.timer) {
            const delay = PROXY_DISPLAY_UPDATE_INTERVAL - (now - state.lastUpdate);
            state.timer = setTimeout(() => {
                state.timer = null;
                if (state.pending) {
                    _doUpdateProxyDisplay(type);
                }
            }, delay);
        }
        return;
    }

    // 已超过节流间隔，直接更新
    _doUpdateProxyDisplay(type);
}

// 实际执行更新的内部函数
function _doUpdateProxyDisplay(type) {
    const state = proxyDisplayUpdateState[type];
    state.lastUpdate = Date.now();
    state.pending = false;

    const config = proxyConfigs[type];
    const selectedCountry = document.getElementById(config.regionSelectId).value;
    if (selectedCountry) {
        populateProxySelect(selectedCountry, config.proxySelectId, window[config.countryMap], window[config.verificationStatus], type);

        // 更新确定按钮状态
        const select = document.getElementById(config.proxySelectId);
        const selectedValue = select.value;
        const isValidSelected = selectedValue &&
            window[config.verificationStatus][selectedValue] &&
            window[config.verificationStatus][selectedValue].status === 'success';
        document.getElementById(config.confirmBtnId).disabled = !isValidSelected;
    }
}

// 重置节流状态（模态框关闭时调用）
function resetProxyDisplayUpdateState(type) {
    const state = proxyDisplayUpdateState[type];
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    state.lastUpdate = 0;
    state.pending = false;
    state.selectOpen = false;
}

function confirmSelectProxy(type) {
    const config = proxyConfigs[type];
    const select = document.getElementById(config.proxySelectId);
    const selectedProxy = select.value;

    if (!selectedProxy) {
        showToast(`请选择一个有效的${type.toUpperCase()}代理`, 'error');
        return;
    }

    // 填入代理地址
    const input = document.getElementById(config.inputId);
    if (input) {
        input.value = selectedProxy.replace(/^socks5:\/\/|^http:\/\/|^https:\/\//, '');
        input.dispatchEvent(new Event('change', { bubbles: true }));
        markModified('proxy');
    }

    // 关闭模态框
    const modal = document.getElementById(config.modalId);
    if (modal) {
        modal.classList.remove('show');
    }

    // 确认选择后停止剩余测试
    if (config.abortController) {
        config.abortController.abort();
        config.abortController = null;
    }

    // 亮起保存和取消按钮
    const saveBtn = document.getElementById('saveProxyBtn');
    const cancelBtn = document.getElementById('cancelProxyBtn');
    if (saveBtn) saveBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
}

function updateProxyConfirmButton(type) {
    const config = proxyConfigs[type];
    const select = document.getElementById(config.proxySelectId);
    const selectedValue = select.value;
    const confirmBtn = document.getElementById(config.confirmBtnId);

    // 检查选中的代理是否可用
    const isValidSelected = selectedValue &&
        window[config.verificationStatus][selectedValue] &&
        window[config.verificationStatus][selectedValue].status === 'success';

    if (confirmBtn) {
        confirmBtn.disabled = !isValidSelected;
    }
}

// 通用单个代理验证函数
function verifySingleProxy(proxy, type, signal) {
    return new Promise((resolve) => {
        const config = proxyConfigs[type];
        const protocol = proxy.protocol || type;
        const proxyUrl = proxy.proxy;
        if (!proxyUrl) {
            resolve();
            return;
        }
        let cleanProxy = String(proxyUrl);
        for (const prefix of ['socks5://', 'http://', 'https://', 'socks5=', 'http=', 'https=']) {
            if (cleanProxy.toLowerCase().startsWith(prefix)) {
                cleanProxy = cleanProxy.substring(prefix.length).trim();
                break;
            }
        }
        const checkProtocol = type === 'https' ? 'https' : protocol;
        const checkUrl = `/admin/check?${checkProtocol}=${encodeURIComponent(cleanProxy)}&_t=${Date.now()}`;

        // 如果已经终止，直接返回
        if (signal && signal.aborted) {
            return resolve();
        }

        // 设置15秒超时
        const timeoutId = setTimeout(() => {
            window[config.verificationStatus][proxyUrl] = {
                status: 'timeout',
                responseTime: null
            };
            updateProxyDisplay(type);
            resolve();
        }, 15000);

        window[config.verificationTimeouts][proxyUrl] = timeoutId;

        fetch(checkUrl, { signal })
            .then(response => response.json())
            .then(data => {
                clearTimeout(timeoutId);
                delete window[config.verificationTimeouts][proxyUrl];

                if (data.success) {
                    window[config.verificationStatus][proxyUrl] = {
                        status: 'success',
                        responseTime: data.responseTime
                    };
                } else {
                    window[config.verificationStatus][proxyUrl] = {
                        status: 'failed',
                        responseTime: null
                    };
                }
                updateProxyDisplay(type);
                resolve();
            })
            .catch(error => {
                clearTimeout(timeoutId);
                delete window[config.verificationTimeouts][proxyUrl];

                window[config.verificationStatus][proxyUrl] = {
                    status: 'failed',
                    responseTime: null
                };
                updateProxyDisplay(type);
                resolve();
            });
    });
}

// ==================== HTTP 相关函数 ====================

// 存储HTTP数据
let httpListData = [];
let httpCountryMap = {};
let httpVerificationStatus = {}; // 存储验证状态
let httpVerificationTimeouts = {}; // 存储超时计时器

// 存储HTTPS数据
let httpsListData = [];
let httpsCountryMap = {};
let httpsVerificationStatus = {}; // 存储验证状态
let httpsVerificationTimeouts = {}; // 存储超时计时器

function showExploreHTTPModal() {
    showExploreProxyModal('http');
}

function closeExploreHTTPModal(event) {
    closeExploreProxyModal('http', event);
}

function loadHTTPList() {
    loadProxyList('http');
}


function populateHTTPRegionSelect() {
    populateProxyRegionSelect('http');
}

function onHTTPRegionChange() {
    onProxyRegionChange('http');
}

function populateHTTPProxySelect(selectedCountry) {
    populateProxySelect(selectedCountry, 'httpProxySelect', httpCountryMap, httpVerificationStatus, 'http');
}

function verifyHTTPProxies(proxies) {
    verifyProxies(proxies, verifySingleHTTP);
}

function verifySingleHTTP(proxy, signal) {
    return verifySingleProxy(proxy, 'http', signal);
}

function updateHTTPDisplay() {
    updateProxyDisplay('http');
}

function confirmSelectHTTP() {
    confirmSelectProxy('http');
}

function updateHTTPConfirmButton() {
    updateProxyConfirmButton('http');
}

function showExploreHTTPSModal() {
    showExploreProxyModal('https');
}

function closeExploreHTTPSModal(event) {
    closeExploreProxyModal('https', event);
}

function loadHTTPSList() {
    loadProxyList('https');
}

function populateHTTPSRegionSelect() {
    populateProxyRegionSelect('https');
}

function onHTTPSRegionChange() {
    onProxyRegionChange('https');
}

function populateHTTPSProxySelect(selectedCountry) {
    populateProxySelect(selectedCountry, 'httpsProxySelect', httpsCountryMap, httpsVerificationStatus, 'https');
}

function verifyHTTPSProxies(proxies) {
    verifyProxies(proxies, verifySingleHTTPS);
}

function verifySingleHTTPS(proxy, signal) {
    return verifySingleProxy(proxy, 'https', signal);
}

function updateHTTPSDisplay() {
    updateProxyDisplay('https');
}

function confirmSelectHTTPS() {
    confirmSelectProxy('https');
}

function updateHTTPSConfirmButton() {
    updateProxyConfirmButton('https');
}

// ============ HOSTS 检查相关函数 ============

// 检查当前访问域名是否在 HOSTS 数组中
function checkHostsMismatch() {
    const currentHostname = window.location.hostname;
    const hosts = currentConfig.HOSTS || [];

    // 检查当前 hostname 是否存在于 HOSTS 数组中
    const isHostInArray = hosts.some(host => {
        // 移除端口号后进行比较
        const hostWithoutPort = host.split(':')[0];
        return hostWithoutPort === currentHostname;
    });

    if (!isHostInArray && hosts.length > 0) {
        // 检查缓存，是否在 24 小时内已提示过
        if (shouldShowHostsMismatchNotification()) {
            showHostsMismatchNotification(currentHostname, hosts);
        }
    }
}

// 检查是否应该显示 HOSTS 不匹配提示
function shouldShowHostsMismatchNotification() {
    const cacheKey = 'hostsMismatchNotificationTime';
    const cachedTime = localStorage.getItem(cacheKey);

    if (!cachedTime) {
        // 没有缓存，应该显示
        return true;
    }

    const lastNotificationTime = parseInt(cachedTime, 10);
    const currentTime = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000; // 24 小时毫秒数

    // 检查是否超过 24 小时
    return (currentTime - lastNotificationTime) > twentyFourHours;
}

// 显示 HOSTS 不匹配提示
function showHostsMismatchNotification(currentHostname, hosts) {
    // 填充模态框中的内容
    const currentHostnameEl = document.getElementById('currentHostname');
    const hostToAddEl = document.getElementById('hostToAdd');
    const currentHostsEl = document.getElementById('currentHosts');

    if (currentHostnameEl) {
        currentHostnameEl.textContent = currentHostname;
    }
    if (hostToAddEl) {
        hostToAddEl.textContent = currentHostname;
    }

    // 填充当前 HOSTS 列表 - 用 HTML badge 而不是纯文本
    if (currentHostsEl) {
        // 清空并用 HTML 结构重新填充
        currentHostsEl.innerHTML = '';

        hosts.forEach((host) => {
            const badge = document.createElement('span');
            badge.className = 'hosts-badge';
            badge.textContent = host;
            currentHostsEl.appendChild(badge);
        });
    }

    // 显示模态框
    const overlay = document.getElementById('hostsMismatchModal');
    if (overlay) {
        const modal = overlay.querySelector('.modal');
        overlay.classList.add('show');
        console.log('✓ 域名不匹配提示已显示');
    } else {
        console.error('✗ 无法找到 hostsMismatchModal 元素');
    }
}

// 关闭 HOSTS 不匹配提示模态框
function closeHostsMismatchModal(event) {
    // 如果有事件对象且点击的不是 overlay 本身，则返回
    if (event && event.target && event.target.id !== 'hostsMismatchModal') {
        return;
    }

    const overlay = document.getElementById('hostsMismatchModal');
    if (overlay) {
        overlay.classList.remove('show');
    }
}

// 处理"知道了！24小时内不提示"按钮
function dismissHostsMismatchNotification() {
    const cacheKey = 'hostsMismatchNotificationTime';
    const currentTime = Date.now();

    // 将当前时间戳保存到 localStorage
    localStorage.setItem(cacheKey, currentTime.toString());

    // 关闭模态框
    closeHostsMismatchModal({ target: { id: 'hostsMismatchModal' } });

    // 显示确认提示
    showToast('🎉 24小时内不会再提示', 'info');
}

