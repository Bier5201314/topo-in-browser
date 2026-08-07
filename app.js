// eNSP 拓扑查看器 / 编辑器
// 依据 eNSP 实际运行原理实现：设备图标(items.xml)、接口展开(cards/topo)、
// 连线类型(Copper/Serial)与两端接口选择、注释拖拽/编辑、GBK 保存。

const NS = 'http://www.w3.org/2000/svg';
const ASSET = 'assets/device/';

function mkEl(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag);
    if (attrs) {
        for (const k in attrs) {
            const v = attrs[k];
            if (v === undefined || v === null) continue;
            if (k === 'textContent') el.textContent = String(v);
            else el.setAttribute(k, v);
        }
    }
    if (parent) parent.appendChild(el);
    return el;
}

function escHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// XML 属性转义：包含 \r\n\t -> 实体（与 eNSP 保存格式一致）
function xmlAttr(s) {
    return String(s == null ? '' : s).replace(/[&<>"'\r\n\t]/g, c => {
        switch (c) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            case '\r': return '&#x0D;';
            case '\n': return '&#x0A;';
            case '\t': return '&#x09;';
        }
        return c;
    });
}

// ---- 注释文本测量 / 颜色转换（eNSP txttip 颜色为带符号 ARGB 整数） ----
let __ctx = null;
function textWidthPx(str, fontSizePx) {
    if (!__ctx) __ctx = document.createElement('canvas').getContext('2d');
    __ctx.font = fontSizePx + "px 'Geist Mono', Consolas, monospace";
    return __ctx.measureText(String(str == null ? '' : str)).width;
}

function intToColor(n) {
    const u = Number(n) || 0;
    return '#' + [(u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff].map(v => v.toString(16).padStart(2, '0')).join('');
}

// 深色模式颜色调整：将过暗的颜色调亮以保证可读性
// isBg=true 时对背景做更强的提亮，isBg=false 时对文字做适中提亮
function adjustColorDark(hex, isBg) {
    const s = String(hex || '#000000').replace('#', '');
    let r = parseInt(s.substr(0, 2), 16) || 0;
    let g = parseInt(s.substr(2, 2), 16) || 0;
    let b = parseInt(s.substr(4, 2), 16) || 0;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const threshold = isBg ? 55 : 90;
    if (lum * 255 < threshold) {
        // 保持色相，仅整体提亮到可读，避免把用户所选的颜色抹成同一种灰
        const target = isBg ? 118 : 178;
        const k = Math.max(1, target / Math.max(1, lum * 255));
        r = Math.min(255, Math.round(r * k));
        g = Math.min(255, Math.round(g * k));
        b = Math.min(255, Math.round(b * k));
    }
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function colorToInt(hex) {
    const s = String(hex || '#000000').replace('#', '').slice(0, 6);
    const r = parseInt(s.substr(0, 2), 16) || 0;
    const g = parseInt(s.substr(2, 2), 16) || 0;
    const b = parseInt(s.substr(4, 2), 16) || 0;
    return ((0xff << 24) | (r << 16) | (g << 8) | b) | 0;
}

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// 接口家族：决定连线类型
function familyOf(name) {
    const n = String(name || '').toUpperCase();
    if (n === 'SERIAL' || n === 'POS' || n === 'E1') return 'serial';
    if (n === 'WLAN' || n === 'RADIO' || n === 'Wifi') return 'wlan';
    return 'net';
}

function lineNameOf(fam) {
    if (fam === 'serial') return 'Serial';
    if (fam === 'wlan') return 'Wlan';
    return 'Copper';
}

// eNSP 端口命名约定：路由器/防火墙/NE/CX 从 0 开始（如 GE0/0/0），
// 交换机/终端/其他设备（S3/C6/WLAN/PC…）从 1 开始（如 GE0/0/1）。
function ifaceStartNumber(model) {
    return /^(AR|NE|USG|CX|FW)/i.test(String(model || '')) ? 0 : 1;
}

// 新增设备模板：接口列表 [ [接口类型, 数量], ... ]
// 接口数量依据 res/items.xml 中每款设备的 description 生成。
const TEMPLATES = {
    // ---- 路由器 AR ----
    'AR201':    { model: 'AR201',    prefix: 'AR', imp: [['Ethernet', 8], ['GE', 1]] },
    'AR1220':   { model: 'AR1220',   prefix: 'AR', imp: [['GE', 2], ['Ethernet', 8], ['Serial', 2]] },
    'AR2220':   { model: 'AR2220',   prefix: 'AR', imp: [['GE', 4], ['Ethernet', 2], ['Serial', 2]] },
    'AR2240':   { model: 'AR2240',   prefix: 'AR', imp: [['GE', 8]] },
    'AR3260':   { model: 'AR3260',   prefix: 'AR', imp: [['GE', 6], ['Ethernet', 4], ['Serial', 4]] },
    'Router':   { model: 'Router',   prefix: 'AR', imp: [['Ethernet', 8], ['GE', 1]] },
    'NE40E':    { model: 'NE40E',    prefix: 'NE', imp: [['GE', 24], ['Serial', 2]] },
    'NE5000E':  { model: 'NE5000E',  prefix: 'NE', imp: [['GE', 24], ['Serial', 2]] },
    'NE9000':   { model: 'NE9000',   prefix: 'NE', imp: [['GE', 24], ['Serial', 2]] },
    'CX':       { model: 'CX',       prefix: 'CX', imp: [['GE', 24], ['Serial', 2]] },
    // ---- 交换机 LSW ----
    'S5700':    { model: 'S5700',    prefix: 'LSW', imp: [['GE', 24]] },
    'S3700':    { model: 'S3700',    prefix: 'LSW', imp: [['Ethernet', 22], ['GE', 2]] },
    'CE6800':   { model: 'CE6800',   prefix: 'CE', imp: [['GE', 24]] },
    'CE12800':  { model: 'CE12800',  prefix: 'CE', imp: [['GE', 24]] },
    // ---- 无线 WLAN ----
    'AC6005':   { model: 'AC6005',   prefix: 'AC', imp: [['Ethernet', 6], ['GE', 2]] },
    'AC6605':   { model: 'AC6605',   prefix: 'AC', imp: [['Ethernet', 24], ['GE', 4]] },
    'AP2010':   { model: 'AP2010',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 1]] },
    'AP2030':   { model: 'AP2030',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP2050':   { model: 'AP2050',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP3030':   { model: 'AP3030',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP4030':   { model: 'AP4030',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP4050':   { model: 'AP4050',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP5010':   { model: 'AP5010',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 1]] },
    'AP5030':   { model: 'AP5030',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP6010':   { model: 'AP6010',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP6050':   { model: 'AP6050',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP6510':   { model: 'AP6510',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP6610':   { model: 'AP6610',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP7030':   { model: 'AP7030',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP7050':   { model: 'AP7050',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP8030':   { model: 'AP8030',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP8130':   { model: 'AP8130',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AP9131':   { model: 'AP9131',   prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    'AD9430':   { model: 'AD9430',   prefix: 'AP', imp: [['Ethernet', 28]] },
    'R250D':    { model: 'R250D',    prefix: 'AP', imp: [['Ethernet', 1], ['Wlan', 2]] },
    // ---- 防火墙 FW ----
    'USG5500':  { model: 'USG5500',  prefix: 'FW', imp: [['GE', 4], ['Ethernet', 8]] },
    'USG6000V': { model: 'USG6000V', prefix: 'FW', imp: [['GE', 24]] },
    // ---- 终端 CLIENT ----
    'PC':       { model: 'PC',       prefix: 'PC', imp: [['Ethernet', 1]] },
    'MCS':      { model: 'MCS',      prefix: 'MCS', imp: [['Ethernet', 1]] },
    'Client':   { model: 'Client',   prefix: 'Client', imp: [['Ethernet', 1]] },
    'Server':   { model: 'Server',   prefix: 'Server', imp: [['Ethernet', 1]] },
    'STA':      { model: 'STA',      prefix: 'STA', imp: [['Wlan', 1]] },
    'Cellphone':{ model: 'Cellphone',prefix: 'CPhone', imp: [['Wlan', 1]] },
    // ---- 其它设备 Other Devices ----
    'Cloud':    { model: 'Cloud',    prefix: 'Cloud', imp: [['Ethernet', 3]] },
    'FRSW':     { model: 'FRSW',     prefix: 'FR', imp: [['Serial', 16]] },
    'HUB':      { model: 'HUB',      prefix: 'HUB', imp: [['Ethernet', 16]] }
};

// 添加设备的分类与 res/items.xml 完全一致（分类名、顺序、每类下的设备顺序）。
// 设备连线与 eNSP 完全一致（名称/线名见 eNSP_Client.exe 图标资源表）。
// 设备分类一一对应 eNSP 的 res\items.xml（category → description 原文）。
const DEVICE_CATALOG = [
    { cat: 'AR',     label: '路由器',   models: ['AR201', 'AR1220', 'AR2220', 'AR2240', 'AR3260', 'Router', 'NE40E', 'NE5000E', 'NE9000', 'CX'] },
    { cat: 'LSW',    label: '交换机',   models: ['S5700', 'S3700', 'CE6800', 'CE12800'] },
    { cat: 'WLAN',   label: '无线局域网', models: ['AC6005', 'AC6605', 'AP2010', 'AP2030', 'AP2050', 'AP3030', 'AP4030', 'AP4050', 'AP5010', 'AP5030', 'AP6010', 'AP6050', 'AP6510', 'AP6610', 'AP7030', 'AP7050', 'AP8030', 'AP8130', 'AP9131', 'AD9430', 'R250D'] },
    { cat: 'FW',     label: '防火墙',   models: ['USG5500', 'USG6000V'] },
    { cat: 'CLIENT', label: '终端',     models: ['PC', 'MCS', 'Client', 'Server', 'STA', 'Cellphone'] },
    { cat: 'Other Devices', label: '其它设备', models: ['Cloud', 'FRSW', 'HUB'] },
    { cat: 'NET',    label: '设备连线', cables: ['Auto', 'Copper', 'Serial', 'POS', 'E1', 'ATM', 'CTL'] }
];

// 设备连线=eNSP 的连线工具。线名与 eNSP 完全一致（Auto/Copper/Serial/POS/E1/ATM/CTL），
// 来源 eNSP_Client.exe 图标资源表 + 用户实际看到的 eNSP 界面命名。写入 topo 可直接被 eNSP 读取。
const CABLE_TYPES = {
    'Auto':   { label: 'Auto',   fam: null,     color: '#9b988c' },
    'Copper': { label: 'Copper', fam: 'net',    color: '#b83636' },
    'Serial': { label: 'Serial', fam: 'serial', color: '#934828' },
    'POS':    { label: 'POS',    fam: 'serial', color: '#d6866a' },
    'E1':     { label: 'E1',     fam: 'serial', color: '#788c5d' },
    'ATM':    { label: 'ATM',    fam: 'net',    color: '#9c87f5' },
    'CTL':    { label: 'CTL',    fam: 'net',    color: '#46443b' }
};

function lineColorOf(ln) {
    if (ln && CABLE_TYPES[ln]) return CABLE_TYPES[ln].color;
    return '#9b988c';
}

// 添加设备面板顶部的“常用”分类（在设备分类之前渲染）
const COMMON_ITEMS = {
    label: '常用',
    items: [
        { model: 'AR2220' },
        { model: 'S5700' },
        { model: 'S3700' },
        { model: 'PC' },
        { cable: 'Copper' },
        { model: 'Server' }
    ]
};

class ENSPTopoViewer {
    constructor() {
        this.svg           = document.getElementById('topoSvg');
        this.topoGroup      = document.getElementById('topoGroup');
        this.devicesLayer   = document.getElementById('devicesLayer');
        this.linesLayer     = document.getElementById('linesLayer');
        this.labelsLayer    = document.getElementById('labelsLayer');
        this.portLayer      = document.getElementById('portLayer');
        this.portsLayer     = document.getElementById('portsLayer');
        this.previewLayer   = document.getElementById('previewLayer');
        this.canvasContainer= document.getElementById('canvasContainer');
        this.dropZone       = document.getElementById('dropZone');
        this.fileInput      = document.getElementById('fileInput');
        this.deviceList     = document.getElementById('deviceList');
        this.palette        = document.getElementById('palette');
        this.propertyPanel  = document.getElementById('propertyPanel');
        this.statusText     = document.getElementById('statusText');
        this.fileNameEl     = document.getElementById('fileName');
        this.zoomLevelEl    = document.getElementById('zoomLevel');
        this.deviceCountEl  = document.getElementById('deviceCount');
        this.lineCountEl    = document.getElementById('lineCount');
        this.canvasHint     = document.getElementById('canvasHint');
        this.canvasHintText = document.getElementById('canvasHintText');

        this.devices = new Map();
        this.lines = [];
        this.txttips = [];
        this.pendingTxt = false;
        this.shapesRaw = '';
        this.topoVersion = '';
        this.fileNameStr = '';
        this.dirty = false;
        this._savedSnap = null;

        this.scale = 1;
        this.translateX = 0;
        this.translateY = 0;

        this.editMode = false;
        this._topologyStarted = false;
        this.activeTool = 'select';
        this.selectedType = null;
        this.selectedId = null;

        this.pendingAddTpl = null;
        this.pendingAddId = null;
        this.lineSourceId = null;
        this.linkState = null;

        this.dragState = null;

        this.undoStack = [];
        this.redoStack = [];
        this._preDrag = null;
        this.showAllPorts = false;
        this.pendingCable = null;

        this._nameCounts = {};
        this.fsHandle = null;
        this.paletteCollapsed = {};

        this.init();
    }

    init() {
        this.bindEvents();
        this.renderPalette();
        this.updateView();
        const saved = localStorage.getItem('ensp-viewer-theme');
        this.setTheme(saved === 'dark');
        const th = localStorage.getItem('ensp-viewer-toolbar-height');
        if (th) { const t = document.querySelector('.toolbar'); t.style.height = th + 'px'; t.style.overflowY = 'hidden'; }
        const lw = localStorage.getItem('ensp-viewer-left-width');
        if (lw) document.querySelector('.left-sidebar').style.width = lw + 'px';
        const rw = localStorage.getItem('ensp-viewer-right-width');
        if (rw) document.querySelector('.right-sidebar').style.width = rw + 'px';
    }

    // ---------------- 深色 / 浅色主题 ----------------
    setTheme(dark) {
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        const btn = document.getElementById('btnTheme');
        if (btn) btn.innerHTML = dark
            ? '<svg class="btn-icon"><use href="#icon-theme-light"/></svg>浅色'
            : '<svg class="btn-icon"><use href="#icon-theme-dark"/></svg>深色';
        localStorage.setItem('ensp-viewer-theme', dark ? 'dark' : 'light');
    }

    toggleTheme() {
        this.setTheme(document.documentElement.getAttribute('data-theme') !== 'dark');
    }

    // ---------------- 事件绑定 ----------------
    bindEvents() {
        document.getElementById('btnNew').addEventListener('click', () => this.newTopo());
        document.getElementById('btnOpen').addEventListener('click', () => this.openSystemFile());
        this.fileInput.addEventListener('change', (e) => {
            const f = e.target.files[0];
            if (f) this.loadFile(f);
            e.target.value = '';
        });

        // 添加设备 / 设备列表 面板的收起-展开
        document.querySelectorAll('.section-head').forEach(h => {
            h.addEventListener('click', () => {
                const sec = h.closest('.sidebar-section');
                if (sec) sec.classList.toggle('collapsed');
            });
        });

        // 拖拽 .topo 打开：绑定到整个画布容器（dropZone 为纯视觉提示，本身不接收指针事件）
        const handleDragOver = (e) => { e.preventDefault(); this.dropZone.classList.add('dragover'); };
        const handleDragLeave = (e) => {
            if (!this.canvasContainer.contains(e.relatedTarget)) this.dropZone.classList.remove('dragover');
        };
        const handleDrop = (e) => {
            e.preventDefault();
            this.dropZone.classList.remove('dragover');
            const f = e.dataTransfer.files[0];
            if (f && f.name.toLowerCase().endsWith('.topo')) this.loadFile(f);
            else this.setStatus('请拖入 .topo 格式的文件', 'error');
        };
        this.canvasContainer.addEventListener('dragover', handleDragOver);
        this.canvasContainer.addEventListener('dragleave', handleDragLeave);
        this.canvasContainer.addEventListener('drop', handleDrop);

        document.getElementById('btnEditMode').addEventListener('click', () => this.toggleEditMode());
        document.getElementById('btnToolSelect').addEventListener('click', () => this.setTool('select'));
        document.getElementById('btnToolLine').addEventListener('click', () => this.setTool('line'));

        document.getElementById('btnZoomIn').addEventListener('click', () => this.zoomAt(this.canvasContainer.clientWidth / 2, this.canvasContainer.clientHeight / 2, 1.25));
        document.getElementById('btnZoomOut').addEventListener('click', () => this.zoomAt(this.canvasContainer.clientWidth / 2, this.canvasContainer.clientHeight / 2, 0.8));
        document.getElementById('btnFit').addEventListener('click', () => this.fitToView());
        document.getElementById('btnReset').addEventListener('click', () => this.resetView());

        document.getElementById('btnSave').addEventListener('click', () => this.save(false));
        document.getElementById('btnSaveAs').addEventListener('click', () => this.save(true));

        document.getElementById('btnTogglePorts').addEventListener('click', () => this.toggleShowPorts());
        document.getElementById('btnAddTxt').addEventListener('click', () => this.beginTxt());
        document.getElementById('btnUndo').addEventListener('click', () => this.undo());
        document.getElementById('btnRedo').addEventListener('click', () => this.redo());
        document.getElementById('btnTheme').addEventListener('click', () => this.toggleTheme());

        const allFs = document.getElementById('allTxtFontSize');
        if (allFs) allFs.addEventListener('change', () => this.setAllTxtFontSize(parseFloat(allFs.value)));

        this.svg.addEventListener('mousedown', (e) => this.onMouseDown(e));
        window.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('mouseup', (e) => this.onMouseUp(e));
        this.svg.addEventListener('click', (e) => this.onCanvasClick(e));
        this.svg.addEventListener('dblclick', (e) => this.onCanvasDblClick(e));

        // 滚轮：向上滚放大，向下滚缩小（与 eNSP 一致）
        this.canvasContainer.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = this.canvasContainer.getBoundingClientRect();
            const f = e.deltaY < 0 ? 1.12 : 0.9;
            this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, f);
        }, { passive: false });

        window.addEventListener('keydown', (e) => {
            const t = (e.target.tagName || '').toLowerCase();
            if (t === 'input' || t === 'textarea' || t === 'select') return;
            if (this.linkModalOpen()) {
                if (e.key === 'Escape') { this.closeLinkModal(); this.cancelLine(); e.preventDefault(); }
                return;
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
            else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); this.redo(); }
            else if ((e.ctrlKey || e.metaKey) && 'sS'.indexOf(e.key) >= 0) { e.preventDefault(); this.save(false); }
            else if ((e.ctrlKey || e.metaKey) && 'oO'.indexOf(e.key) >= 0) { e.preventDefault(); this.openSystemFile(); }
            else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelection();
            else if (e.key === 'Escape') { this.cancelAll(); this.deselectAll(); }
            else if (e.key === '+' || e.key === '=') this.zoomAt(this.canvasContainer.clientWidth / 2, this.canvasContainer.clientHeight / 2, 1.2);
            else if (e.key === '-') this.zoomAt(this.canvasContainer.clientWidth / 2, this.canvasContainer.clientHeight / 2, 0.8);
            else if (e.key === '0') this.fitToView();
        });

        // 连线参数对话框
        document.getElementById('linkCancel').addEventListener('click', () => { this.closeLinkModal(); this.cancelLine(); });
        document.getElementById('linkOk').addEventListener('click', () => this.commitLink());
        document.getElementById('linkType').addEventListener('change', (e) => {
            if (this.linkState) { this.linkState.family = e.target.value; this.populateLinkSels(); }
        });
        document.getElementById('linkModal').addEventListener('mousedown', (e) => {
            if (e.target.id === 'linkModal') { this.closeLinkModal(); this.cancelLine(); }
        });

        // 右键：取消粘性放置/已选连线，恢复拖拽模式；无放置状态时取消当前选中
        this.svg.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (this.pendingAddId || this.pendingTxt || this.pendingCable || this.lineSourceId) {
                this.cancelAll();
                this.svg.style.cursor = 'grab';
                this.setStatus('已取消，恢复拖拽模式');
            } else {
                this.deselectAll();
            }
        });

        // 工具栏高度：拖动底部手柄自由调节（可完全隐藏）
        const resizer = document.getElementById('toolbarResizer');
        const toolbar = document.querySelector('.toolbar');
        resizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startH = toolbar.offsetHeight;
            const move = (ev) => {
                const h = Math.max(0, Math.min(280, startH + (ev.clientY - startY)));
                toolbar.style.height = h + 'px';
                toolbar.style.overflowY = 'hidden';
                localStorage.setItem('ensp-viewer-toolbar-height', String(h));
            };
            const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); resizer.classList.remove('active'); };
            resizer.classList.add('active');
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });

        // 左右侧栏：拖动分隔条调整宽度（可完全隐藏）
        const bindSideResize = (resId, sidebarSel, key, dir) => {
            const rs = document.getElementById(resId);
            const sb = document.querySelector(sidebarSel);
            rs.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = sb.offsetWidth;
                const move = (ev) => {
                    const dx = ev.clientX - startX;
                    let w = dir === 'left' ? startW - dx : startW + dx;
                    w = Math.max(0, Math.min(420, w));
                    sb.style.width = w + 'px';
                    localStorage.setItem(key, String(w));
                };
                const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); rs.classList.remove('active'); };
                rs.classList.add('active');
                document.addEventListener('mousemove', move);
                document.addEventListener('mouseup', up);
            });
        };
        bindSideResize('leftResizer', '.left-sidebar', 'ensp-viewer-left-width', 'right');
        bindSideResize('rightResizer', '.right-sidebar', 'ensp-viewer-right-width', 'left');
    }

    linkModalOpen() {
        return document.getElementById('linkModal').style.display !== 'none';
    }

    // ---------------- 编辑模式 / 工具 ----------------
    enableEdit() {
        if (this.editMode) return;
        this.editMode = true;
        this.cancelAll();
        if (this.linkModalOpen()) this.closeLinkModal();
        this.updateModeBar();
        this.setTool('select');
        this.render();
        this.setStatus('已开启编辑模式');
    }

    toggleEditMode() {
        this.editMode = !this.editMode;
        this.cancelAll();
        if (this.linkModalOpen()) this.closeLinkModal();
        this.updateModeBar();
        if (this.editMode) {
            this.setTool('select');
            this.setStatus('已开启编辑模式');
        } else {
            this.deselectAll();
            this.setStatus('已关闭编辑模式（只读查看）');
        }
        this.render();
    }

    setTool(t) {
        this.activeTool = t;
        this.cancelAll();
        this.setToolButtonClasses();
        this.setStatus(t === 'line' ? '连线工具：可在“添加设备→设备连线”选连线类型，再依次点击两台设备的接口' : '选择工具：拖动设备/注释/接口可移动');
    }

    updateModeBar() {
        const btnEdit = document.getElementById('btnEditMode');
        btnEdit.classList.toggle('active', this.editMode);
        btnEdit.setAttribute('data-tip', this.editMode ? '编辑模式：开' : '编辑模式：关');
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('is-disabled', !this.editMode));
        this.setToolButtonClasses();
    }

    setToolButtonClasses() {
        if (!this.editMode) {
            document.getElementById('btnToolSelect').classList.remove('active');
            document.getElementById('btnToolLine').classList.remove('active');
        } else {
            document.getElementById('btnToolSelect').classList.toggle('active', this.activeTool === 'select');
            document.getElementById('btnToolLine').classList.toggle('active', this.activeTool === 'line');
        }
    }

    setHint(txt) {
        if (txt) { this.canvasHintText.textContent = txt; this.canvasHint.style.display = 'block'; }
        else this.canvasHint.style.display = 'none';
    }

    setStatus(txt, type) {
        this.statusText.textContent = txt;
        this.statusText.style.color = type === 'error' ? '#d64545' : '#6e6d68';
    }

    // ---------------- 文件 ----------------
    async openSystemFile() {
        if (window.showOpenFilePicker) {
            try {
                const [h] = await window.showOpenFilePicker({ types: [{ description: 'eNSP 拓扑', accept: { 'application/xml': ['.topo', '.xml'] } }], multiple: false });
                this.fsHandle = h;
                await this.loadFile(await h.getFile());
                return;
            } catch (err) { if (err && err.name === 'AbortError') return; }
        }
        this.fileInput.click();
    }

    loadFile(file) {
        this.fileNameStr = file.name;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const ab = e.target.result;
                let text;
                try { text = new TextDecoder('gbk').decode(ab); }
                catch (x) { text = new TextDecoder('utf-8').decode(ab); }
                this.parseTopo(text);
                this.markClean();
                this.render();
                this.fitToView();
                this.fileNameEl.textContent = file.name;
                this.dropZone.style.display = 'none';
                this.svg.style.display = 'block';
                this._topologyStarted = true;
                this.setStatus('已加载: ' + file.name);
            } catch (err) {
                console.error(err);
                this.setStatus('解析失败: ' + err.message, 'error');
            }
        };
        reader.onerror = () => this.setStatus('读取文件失败', 'error');
        reader.readAsArrayBuffer(file);
    }

    // 新建空白拓扑（与 eNSP 新建工程一致：清空后直接进入编辑模式）
    newTopo() {
        if ((this.devices.size || this.lines.length) && !window.confirm('新建将清空当前拓扑，是否继续？')) return;
        this._topologyStarted = true;
        this.devices.clear();
        this.lines = [];
        this.txttips = [];
        this.shapesRaw = '';
        this.topoVersion = '1.2.00.390';
        this.fileNameStr = '';
        this.fileNameEl.textContent = '';
        this.fsHandle = null;
        this.undoStack = [];
        this.redoStack = [];
        this.showAllPorts = false;
        this.pendingCable = null;
        this.cancelAll();
        this.dropZone.style.display = 'none';
        this.svg.style.display = 'block';
        this.render();
        this.markClean();
        this.enableEdit();
        this.fitToView();
        this.setStatus('已新建空白拓扑（编辑模式已开启）');
    }

    // ---------------- 解析 ----------------
    parseTopo(xmlString) {
        const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
        if (doc.querySelector('parsererror')) throw new Error('XML 解析错误');
        const topoEl = doc.querySelector('topo');
        if (!topoEl) throw new Error('不是有效的拓扑文件');

        this.topoVersion = topoEl.getAttribute('version') || '';
        this.devices.clear();
        this.lines = [];
        this.txttips = [];

        doc.querySelectorAll('devices > dev').forEach(devEl => {
            const attrs = {};
            for (let i = 0; i < devEl.attributes.length; i++) attrs[devEl.attributes[i].name] = devEl.attributes[i].value;
            const dev = { attrs, id: attrs.id, name: attrs.name || '未知', model: attrs.model || '未知',
                cx: parseFloat(attrs.cx) || 0, cy: parseFloat(attrs.cy) || 0, slots: [] };
            devEl.querySelectorAll(':scope > slot').forEach(slotEl => {
                const sAttrs = {};
                for (let i = 0; i < slotEl.attributes.length; i++) sAttrs[slotEl.attributes[i].name] = slotEl.attributes[i].value;
                const slot = { attrs: sAttrs, interfaces: [] };
                slotEl.querySelectorAll(':scope > interface').forEach(ifEl => {
                    slot.interfaces.push({ sztype: ifEl.getAttribute('sztype') || '', interfacename: ifEl.getAttribute('interfacename') || '', count: parseInt(ifEl.getAttribute('count')) || 0 });
                });
                const extras = [];
                slotEl.querySelectorAll(':scope > interfaceMap').forEach(mEl => {
                    const m = {};
                    for (let i = 0; i < mEl.attributes.length; i++) m[mEl.attributes[i].name] = mEl.attributes[i].value;
                    extras.push(m);
                });
                slot.extras = extras;
                dev.slots.push(slot);
            });
            dev.ifaces = this.expandIfaces(dev);
            this.devices.set(dev.id, dev);
        });

        doc.querySelectorAll('lines > line').forEach(lineEl => {
            const attrs = {};
            for (let i = 0; i < lineEl.attributes.length; i++) attrs[lineEl.attributes[i].name] = lineEl.attributes[i].value;
            const pairs = [];
            lineEl.querySelectorAll(':scope > interfacePair').forEach(pEl => {
                const pa = {};
                for (let i = 0; i < pEl.attributes.length; i++) pa[pEl.attributes[i].name] = pEl.attributes[i].value;
                pairs.push(pa);
            });
            if (pairs.length) this.lines.push({ attrs, srcDeviceID: attrs.srcDeviceID, destDeviceID: attrs.destDeviceID, pairs });
        });

        const sh = doc.querySelector('shapes');
        this.shapesRaw = sh ? new XMLSerializer().serializeToString(sh) : '';

        doc.querySelectorAll('txttips > txttip').forEach(tEl => {
            const attrs = {};
            for (let i = 0; i < tEl.attributes.length; i++) attrs[tEl.attributes[i].name] = tEl.attributes[i].value;
            attrs.left = parseFloat(attrs.left) || 0; attrs.top = parseFloat(attrs.top) || 0;
            attrs.right = parseFloat(attrs.right) || 0; attrs.bottom = parseFloat(attrs.bottom) || 0;
            if (attrs.content === undefined) attrs.content = '';
            this.txttips.push(attrs);
        });

        this.updateCounts();
        this.updateNameCounter();
    }

    // 展开设备插槽中的接口，得到有序接口数组（用于端口编号/连线）。
    // 命名与 eNSP 一致：同一接口类型在同一插槽内连续编号，相同接口类型的
    // 多个 <interface> 块续接编号。路由器/防火墙从 GE0/0/0 开始，其余设备从 GE0/0/1 开始。
    expandIfaces(dev) {
        const list = [];
        const startN = ifaceStartNumber(dev.model);
        dev.slots.forEach(slot => {
            const slotNo = (slot.attrs.isMainBoard === '1' || slot.attrs.number === 'slot17') ? '0' : (slot.attrs.id || '0');
            const counters = {};
            slot.interfaces.forEach(iface => {
                const base = iface.interfacename || 'GE';
                const count = iface.count || 0;
                for (let i = 0; i < count; i++) {
                    let nth;
                    if (counters[base] === undefined) nth = counters[base] = startN;
                    else nth = ++counters[base];
                    list.push({ name: base + slotNo + '/0/' + nth, base, family: familyOf(base), index: list.length });
                }
            });
        });
        return list;
    }

    freeIndices(dev) {
        const used = new Set();
        this.lines.forEach(l => l.pairs.forEach(p => {
            if (l.srcDeviceID === dev.id) used.add(p.srcIndex);
            if (l.destDeviceID === dev.id) used.add(p.tarIndex);
        }));
        return dev.ifaces.map(x => x.index).filter(i => !used.has(i));
    }

    // ---------------- 渲染 ----------------
    render() {
        this.devicesLayer.innerHTML = '';
        this.linesLayer.innerHTML = '';
        this.labelsLayer.innerHTML = '';
        this.portLayer.innerHTML = '';
        this.renderLines();
        this.renderDevices();
        this.renderTxttips();
        this.renderAllPorts();
        this.renderDeviceList();
        this.updateCounts();
        this.setToolButtonClasses();
        this.applySelection();
        this.refreshPanel();
        this.updateDirty();
    }

    renderDevices() {
        const hw = 52, hh = 36;
        this.devices.forEach((dev, id) => {
            const g = mkEl('g', { 'class': 'device-group' + (this.editMode ? ' editable' : ''), 'data-id': id, transform: 'translate(' + dev.cx + ',' + dev.cy + ')' });
            const rect = mkEl('rect', { 'class': 'device-rect', x: -hw, y: -hh, width: 104, height: 72 });
            g.appendChild(rect);
            const body = mkEl('g', { 'class': 'device-body' });
            const href = this.deviceIcon(dev.model);
            if (href) body.appendChild(mkEl('image', { 'class': 'device-icon-img', href, x: -20, y: -27, width: 44, height: 44, preserveAspectRatio: 'xMidYMid' }));
            body.appendChild(mkEl('text', { x: 0, y: 9, 'class': 'device-label', textContent: dev.name }));
            body.appendChild(mkEl('text', { x: 0, y: 21, 'class': 'device-model-txt', textContent: dev.model }));
            g.appendChild(body);
            this.devicesLayer.appendChild(g);
        });
    }

    renderLines() {
        this.portLayer.innerHTML = '';
        this.lines.forEach((line, li) => {
            const s = this.devices.get(line.srcDeviceID);
            const d = this.devices.get(line.destDeviceID);
            if (!s || !d) return;
            (line.pairs || []).forEach((pair, pi) => {
                this.redrawPair(li, pi);
            });
        });
    }

    // 线缆始终焊接在设备之间：两端锚点在设备边缘，不随标签移动
    straightPath(p1, p2) {
        return 'M ' + p1[0] + ' ' + p1[1] + ' L ' + p2[0] + ' ' + p2[1];
    }

    // 更新某一对连线及其端口图元（标签/连接点/端点圆点）——不整层重绘
    redrawPair(li, pi) {
        const line = this.lines[li];
        if (!line || !line.pairs[pi]) return;
        const s = this.devices.get(line.srcDeviceID);
        const d = this.devices.get(line.destDeviceID);
        if (!s || !d) return;
        const pair = line.pairs[pi];
        const a1 = this.portAnchor(s, d, pair, 'src');
        const a2 = this.portAnchor(d, s, pair, 'tar');
        const dpath = this.straightPath(a1, a2);
        const isSer = pair.lineName === 'Serial' || pair.lineName === 'Wlan' || pair.lineName === 'E1' || pair.lineName === 'POS';

        const sel = '[data-line-idx="' + li + '"][data-pi="' + pi + '"]';
        const paths = this.linesLayer.querySelectorAll('.line-path' + sel + ', .line-hotspot' + sel);
        const lcol = lineColorOf(pair.lineName);
        if (paths.length === 0) {
            const p = mkEl('path', { 'class': 'line-path' + (isSer ? ' is-serial' : ''), d: dpath, fill: 'none', 'data-line-idx': li, 'data-pi': pi }, this.linesLayer);
            p.setAttribute('style', '--lc:' + lcol);
            mkEl('path', { 'class': 'line-hotspot', d: dpath, fill: 'none', 'data-line-idx': li, 'data-pi': pi }, this.linesLayer);
        } else {
            paths.forEach(p => { p.setAttribute('d', dpath); p.setAttribute('style', '--lc:' + lcol); });
        }

        const ns = this.portName(s, pair.srcIndex);
        const nd = this.portName(d, pair.tarIndex);
        const p1 = this.portLabelPos(s, pair, pi, 'src', a1);
        const p2 = this.portLabelPos(d, pair, pi, 'tar', a2);
        const chipSel = '[data-li="' + li + '"][data-pi="' + pi + '"]';
        let chipS = this.portLayer.querySelector('.port-chip[data-side="src"]' + chipSel);
        let chipD = this.portLayer.querySelector('.port-chip[data-side="tar"]' + chipSel);
        if (!chipS) chipS = mkEl('g', { 'class': 'port-chip', 'data-side': 'src', 'data-li': li, 'data-pi': pi }, this.portLayer);
        if (!chipD) chipD = mkEl('g', { 'class': 'port-chip', 'data-side': 'tar', 'data-li': li, 'data-pi': pi }, this.portLayer);
        this.setChip(chipS, p1, ns);
        this.setChip(chipD, p2, nd);
    }

    setChip(g, pos, text) {
        g.setAttribute('transform', 'translate(' + pos[0] + ',' + pos[1] + ')');
        if (g.childNodes.length === 0) {
            mkEl('circle', { 'class': 'port-end', r: 3.2 }, g);
            mkEl('circle', { 'class': 'port-dot', r: 4.5 }, g);
            // 接口名只在该按钮启用时显示（未启用时不显示任何接口）
            if (this.showAllPorts) {
                const w = Math.max(18, String(text).length * 6.4 + 8);
                mkEl('rect', { 'class': 'port-label-bg', x: -w / 2, y: -9, width: w, height: 16 }, g);
                mkEl('text', { 'class': 'port-label', x: 0, y: 2, textContent: text }, g);
            }
        }
    }

    // 线缆锚点：设备边缘 + 多线排布（线缆永远固定在设备上，跟随设备移动）
    portAnchor(dev, other, pair, side) {
        const base = this.edgeAnchor(dev, other);
        const g = this.seatFor(dev, other, pair);
        if (g.n > 1) {
            const dx = other.cx - dev.cx, dy = other.cy - dev.cy;
            const len = Math.hypot(dx, dy) || 1;
            const px = -dy / len, py = dx / len;
            const off = (g.k - (g.n - 1) / 2) * 9;
            return [base[0] + px * off, base[1] + py * off];
        }
        return base;
    }

    // 标签位置：仅当标签被拖动后使用保存的坐标，否则位于线缆锚点
    portLabelPos(dev, pair, pi, side, anchor) {
        const k = side;
        if (String(pair[k + 'LabelMoved']) === '1') {
            const x = parseFloat(pair[k + 'LabelX']), y = parseFloat(pair[k + 'LabelY']);
            if (isFinite(x) && isFinite(y)) return [x, y];
        }
        if (String(pair[k + 'BoundRectIsMoved']) === '1') {
            const x = parseFloat(pair[k + 'BoundRect_X']), y = parseFloat(pair[k + 'BoundRect_Y']);
            if (isFinite(x) && isFinite(y)) return [x, y];
        }
        return anchor;
    }

    // 同一台设备与同一台设备之间的多条连线，沿垂直方向排开（解决重叠）
    seatFor(dev, other, pair) {
        let n = 0, k = 0, found = -1;
        this.lines.forEach(l => (l.pairs || []).forEach(p => {
            let oid = null;
            if (l.srcDeviceID === dev.id) oid = l.destDeviceID;
            else if (l.destDeviceID === dev.id) oid = l.srcDeviceID;
            if (oid === other.id) { if (p === pair) found = n; n++; }
        }));
        return { k: found >= 0 ? found : 0, n: Math.max(1, n) };
    }

    edgeAnchor(from, to) {
        const hw = 52, hh = 36;
        const dx = to.cx - from.cx, dy = to.cy - from.cy;
        if (dx === 0 && dy === 0) return [from.cx, from.cy];
        const sx = hw / Math.abs(dx), sy = hh / Math.abs(dy);
        const s = Math.min(sx, sy);
        return [from.cx + dx * s, from.cy + dy * s];
    }

    portName(dev, idx) { const it = dev.ifaces[idx]; return it ? it.name : 'Port' + idx; }

    addPortLabel(pos, text) { this.setChip(mkEl('g', { 'class': 'port-chip' }, this.portLayer), pos, text); }

    renderTxttips() {
        this.labelsLayer.innerHTML = '';
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        this.txttips.forEach((tip, i) => {
            this.layoutTxt(tip);
            const pad = 3;
            const fs = tip._fs, lineH = tip._lineH;
            const w = (tip.right - tip.left) || 60, h = (tip.bottom - tip.top) || 16;
            const g = mkEl('g', { 'class': 'txttip-group' + (this.editMode ? ' editable' : ''), 'data-idx': i });
            let fg = intToColor(tip.txtcolor != null ? tip.txtcolor : -16777216);
            let bg = intToColor(tip.txtbkcolor != null ? tip.txtbkcolor : -2331);
            // 深色模式：将过暗的文字/底色调亮以保证可读性
            if (isDark) {
                fg = adjustColorDark(fg);
                bg = adjustColorDark(bg, true);
            }
            mkEl('rect', { 'class': 'txttip-bg', x: tip.left, y: tip.top, width: w, height: h, rx: 4, ry: 4, fill: bg, stroke: fg }, g);
            const txt = mkEl('text', { 'class': 'txttip-text', x: tip.left + pad, y: tip.top + pad + fs * 0.8, fill: fg, 'font-size': fs, 'font-family': 'Geist Mono, Consolas, monospace' });
            (String(tip.content || '').split(/\r?\n/)).forEach((ln, li) => mkEl('tspan', { x: tip.left + pad, dy: li === 0 ? 0 : lineH, textContent: ln }, txt));
            g.appendChild(txt);
            if (this.editMode && this.selectedType === 'txt' && this.selectedId === i) {
                mkEl('rect', { 'class': 'txt-resize-handle', x: tip.right - 8, y: tip.bottom - 8, width: 12, height: 12 }, g);
            }
            this.labelsLayer.appendChild(g);
        });
        this.updateDirty();
    }

    // 注释与文本框大小同步变化（eNSP 行为）：
    //  - 字号未存时，从注释框高度反推一次并固化（tip.fontsize），显示字号永远等于它；
    //  - 此后字号是唯一“事实来源”：文本框宽高始终由【字号 + 内容】严格推导，绝不保留旧框；
    //  - 改字号 → 框同时变大/变小；拖拽移动 → 字号不变、框大小不变；拖动右下角手柄 → 框高变、字号跟随变。
    layoutTxt(tip, fsOverride) {
        const pad = 3;
        const lnArr = String(tip.content || '').split(/\r?\n/);
        let fs = parseFloat(fsOverride != null ? fsOverride : tip.fontsize);
        if (!(fs > 0)) {
            const bh = tip.bottom - tip.top;
            fs = (isFinite(bh) && bh > 10) ? Math.max(4, Math.min(36, Math.round((bh - pad * 2) / Math.max(1, lnArr.length)))) : 8;
        }
        fs = Math.max(4, Math.min(60, Math.round(fs)));
        tip.fontsize = fs;
        tip._fs = fs;
        tip._lineH = fs;
        let maxW = 0;
        lnArr.forEach(ln => { const ww = textWidthPx(ln, fs); if (ww > maxW) maxW = ww; });
        const w = Math.max(22, Math.ceil(maxW) + pad * 2);
        const h = Math.max(12, lnArr.length * fs + pad * 2);
        tip.right = tip.left + w;
        tip.bottom = tip.top + h;
        return fs;
    }

    // 设备四周环绕分布接口位置（用于“显示所有接口”）
    ifaceSlotPos(dev, idx) {
        const n = dev.ifaces.length, hw = 52, hh = 36;
        const per = Math.max(1, Math.ceil(n / 4));
        const side = Math.floor(idx / per) % 4; // 0 下,1 右,2 上,3 左
        const p = idx - side * per;
        const t = per > 1 ? (p - (per - 1) / 2) / ((per - 1) / 2) * 0.8 : 0;
        switch (side) {
            case 0: return [dev.cx + t * hw, dev.cy + hh + 8];
            case 1: return [dev.cx + hw + 8, dev.cy + t * hh];
            case 2: return [dev.cx + t * hw, dev.cy - hh - 8];
            default: return [dev.cx - hw - 8, dev.cy + t * hh];
        }
    }

    toggleShowPorts() {
        this.showAllPorts = !this.showAllPorts;
        const b = document.getElementById('btnTogglePorts');
        if (b) {
            b.classList.toggle('active', this.showAllPorts);
            b.innerHTML = this.showAllPorts
                ? '<svg class="btn-icon"><use href="#icon-plug"/></svg>隐藏接口'
                : '<svg class="btn-icon"><use href="#icon-plug"/></svg>显示接口';
        }
        this.setStatus(this.showAllPorts ? '已显示已使用的接口' : '已隐藏接口（不显示任何接口）');
        this.renderLines();
        this.renderAllPorts();
    }

    // 接口展示以“线缆锚点处的可移动接口标签”为准（见 setChip），不再绘制设备槽位标记
    renderAllPorts() {
        this.portsLayer.innerHTML = '';
    }

    renderDeviceList() {
        this.deviceList.innerHTML = '';
        if (!this.devices.size) { this.deviceList.innerHTML = '<p class="empty-hint">请打开拓扑文件</p>'; return; }
        [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh')).forEach(dev => {
            const item = document.createElement('div');
            item.className = 'device-item';
            item.dataset.id = dev.id;
            const href = this.deviceIcon(dev.model);
            item.innerHTML = '<div class="device-icon">' + (href ? '<img src="' + href + '" alt="">' : '') + '</div>' +
                '<div class="device-info"><div class="device-name"></div><div class="device-model"></div></div>';
            item.querySelector('.device-name').textContent = dev.name;
            item.querySelector('.device-model').textContent = dev.model;
            item.addEventListener('click', () => { this.selectDevice(dev.id); this.centerOn(dev.id); });
            this.deviceList.appendChild(item);
        });
    }

    // ---------------- 图标（依据 res/items.xml 的 topoIcon） ----------------
    deviceIcon(model) {
        const m = String(model || '').toUpperCase();
        const T = [
            [/^NE9000/, 'ne9000_little_icon.png'],
            [/^NE5/, 'ne5000e_little_icon.png'],
            [/^NE4/, 'NE40E.png'],
            [/^CX/, 'cx_little_icon.png'],
            [/^CE128/, 's128.png'],
            [/^CE/, 'iCE6800.png'],
            [/^S5700/, 'iCorelsw.png'],
            [/^S3700/, 'iL3lsw.png'],
            [/^STA/, 'iStation.png'],
            [/^S/, 'iL3lsw.png'],
            [/^AR/, 'iRouter.png'],
            [/^ROUTER/, 'iRouter.png'],
            [/^NE/, 'ne.png'],
            [/CLOUD/, 'cloud3.png'],
            [/^CLIENT/, 'iWebClient.png'],
            [/^SERVER/, 'iWebServer.png'],
            [/CELL|PHONE/, 'iCellphone.png'],
            [/MCS/, 'iMulticastSource.png'],
            [/^AP/, 'iAP.png'],
            [/^AC/, 'iAC.png'],
            [/USG|FW|FIRE/, 'iFW.png'],
            [/^FR/, 'fr.png'],
            [/HUB/, 'iHUB.png'],
            [/^PC$|LAPTOP/, 'iLaptop.png']
        ];
        for (const [re, f] of T) { if (re.test(m)) return ASSET + f; }
        return ASSET + 'iRouter.png';
    }

    // ---------------- 视图 ----------------
    screenToWorld(sx, sy) {
        const r = this.canvasContainer.getBoundingClientRect();
        return { x: (sx - r.left - this.translateX) / this.scale, y: (sy - r.top - this.translateY) / this.scale };
    }

    updateView() { this.topoGroup.setAttribute('transform', 'translate(' + this.translateX + ',' + this.translateY + ') scale(' + this.scale + ')'); this.zoomLevelEl.textContent = Math.round(this.scale * 100) + '%'; }
    updateZoom() { this.updateView(); }

    zoomAt(x, y, f) {
        const ns = Math.max(0.05, Math.min(8, this.scale * f));
        const px = (x - this.translateX) / this.scale, py = (y - this.translateY) / this.scale;
        this.scale = ns; this.translateX = x - px * ns; this.translateY = y - py * ns;
        this.updateView();
    }

    fitToView() {
        if (!this.devices.size) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this.devices.forEach(d => { minX = Math.min(minX, d.cx - 60); maxX = Math.max(maxX, d.cx + 60); minY = Math.min(minY, d.cy - 50); maxY = Math.max(maxY, d.cy + 50); });
        this.txttips.forEach(t => { minX = Math.min(minX, t.left); maxX = Math.max(maxX, t.right); minY = Math.min(minY, t.top); maxY = Math.max(maxY, t.bottom); });
        if (!isFinite(minX)) return;
        const pad = 90, w = Math.max(1, maxX - minX + pad * 2), h = Math.max(1, maxY - minY + pad * 2);
        const cw = this.canvasContainer.clientWidth, ch = this.canvasContainer.clientHeight;
        this.scale = Math.min(2, cw / w, ch / h);
        this.translateX = cw / 2 - ((minX + maxX) / 2) * this.scale;
        this.translateY = ch / 2 - ((minY + maxY) / 2) * this.scale;
        this.updateView();
    }

    resetView() { this.scale = 1; this.translateX = 0; this.translateY = 0; this.updateView(); }

    centerOn(id) {
        const d = this.devices.get(id);
        if (!d) return;
        this.translateX = this.canvasContainer.clientWidth / 2 - d.cx * this.scale;
        this.translateY = this.canvasContainer.clientHeight / 2 - d.cy * this.scale;
        this.updateView();
    }

    // ---------------- 鼠标交互 ----------------
    onMouseDown(e) {
        if (e.button !== 0) return;
        const target = e.target;
        if (this.pendingAddId) {
            const w = this.screenToWorld(e.clientX, e.clientY);
            this.placePending(w.x, w.y);
            e.preventDefault();
            return;
        }
        if (this.pendingTxt) {
            const w = this.screenToWorld(e.clientX, e.clientY);
            this.placeTxt(w.x, w.y);
            e.preventDefault();
            return;
        }

        const rh = target.closest('.txt-resize-handle');
        if (rh && this.editMode && this.activeTool === 'select') {
            const tipG = target.closest('.txttip-group');
            if (tipG) {
                const idx = parseInt(tipG.dataset.idx, 10);
                const tip = this.txttips[idx];
                if (tip) {
                    this.selectTxt(idx);
                    const w = this.screenToWorld(e.clientX, e.clientY);
                    this._preDrag = this.snapshot();
                    this.dragState = { type: 'txtresize', idx, didMove: false, oy: w.y, c0b: tip.bottom };
                }
            }
            e.preventDefault();
            return;
        }

        const tipG = target.closest('.txttip-group');
        if (tipG) {
            if (this.editMode && this.activeTool === 'line') return;
            const idx = parseInt(tipG.dataset.idx, 10);
            this.selectTxt(idx);
            if (this.editMode && this.activeTool === 'select') {
                const tip = this.txttips[idx];
                if (tip) {
                    const w = this.screenToWorld(e.clientX, e.clientY);
                    this._preDrag = this.snapshot();
                    this.dragState = { type: 'txt', idx, didMove: false, ox: w.x, oy: w.y, c0l: tip.left, c0t: tip.top, w: tip.right - tip.left, h: tip.bottom - tip.top };
                }
                e.preventDefault();
            }
            return;
        }

        const chip = target.closest('.port-chip');
        if (chip && this.editMode && this.activeTool !== 'line') {
            const dot = target.closest('.port-dot');
            if (dot) {
                this._preDrag = this.snapshot();
                this.dragState = { type: 'port', li: parseInt(chip.dataset.li, 10), pi: parseInt(chip.dataset.pi, 10), side: chip.dataset.side, didMove: false };
                e.preventDefault();
                return;
            }
            this.selectLine(parseInt(chip.dataset.li, 10));
            return;
        }

        const ap = target.closest('.all-port');
        if (ap) {
            const id = ap.dataset.id, idx = parseInt(ap.dataset.idx, 10);
            if (!this.editMode) { this.selectDevice(id); return; }
            if (this.activeTool === 'line') { this.lineHitPort(id, idx); e.preventDefault(); return; }
            // 选择工具下：按住接口可拖出橡皮筋连线，拖到目标设备/接口上松手即可建链
            const dev = this.devices.get(id);
            if (!dev) return;
            const w = this.screenToWorld(e.clientX, e.clientY);
            this._preDrag = this.snapshot();
            this.dragState = { type: 'portlink', sid: id, si: idx, didMove: false, x: w.x, y: w.y };
            this.showLinkPreview(this.portAnchorFor(dev, idx), w.x, w.y);
            e.preventDefault();
            return;
        }

        const devG = target.closest('.device-group');
        if (devG) {
            const id = devG.dataset.id;
            if (this.editMode && this.activeTool === 'line') { this.lineHitDevice(id); return; }
            this.selectDevice(id);
            if (this.editMode && this.activeTool === 'select') {
                const w = this.screenToWorld(e.clientX, e.clientY);
                const d = this.devices.get(id);
                this._preDrag = this.snapshot();
                this.dragState = { type: 'device', id, didMove: false, ox: w.x, oy: w.y, c0x: d.cx, c0y: d.cy };
                e.preventDefault();
            }
            return;
        }

        if (target.closest('.line-path, .line-hotspot')) {
            const idx = parseInt(target.closest('.line-path, .line-hotspot').getAttribute('data-line-idx'), 10);
            if (!isNaN(idx)) { this.selectLine(idx); return; }
        }

        this.dragState = { type: 'pan', bx: this.translateX, by: this.translateY, sx: e.clientX, sy: e.clientY };
        this.svg.style.cursor = 'grabbing';
    }

    onMouseMove(e) {
        if (this.pendingAddId) {
            const w = this.screenToWorld(e.clientX, e.clientY);
            this.ghostX = w.x; this.ghostY = w.y;
            this.showGhost(w.x, w.y);
            return;
        }
        if (!this.dragState) return;
        const st = this.dragState;
        const w = this.screenToWorld(e.clientX, e.clientY);
        if (st.type === 'pan') {
            this.translateX = st.bx + (e.clientX - st.sx);
            this.translateY = st.by + (e.clientY - st.sy);
            this.updateView();
        } else if (st.type === 'device') {
            st.didMove = true;
            const d = this.devices.get(st.id);
            if (!d) return;
            d.cx = st.c0x + (w.x - st.ox);
            d.cy = st.c0y + (w.y - st.oy);
            const g = this.devicesLayer.querySelector('[data-id="' + d.id + '"]');
            if (g) g.setAttribute('transform', 'translate(' + d.cx + ',' + d.cy + ')');
            this.updateLinesFor(d.id);
            if (this.showAllPorts) this.renderAllPorts();
        } else if (st.type === 'txt') {
            st.didMove = true;
            const tip = this.txttips[st.idx];
            if (!tip) return;
            tip.left = st.c0l + (w.x - st.ox);
            tip.top = st.c0t + (w.y - st.oy);
            tip.right = tip.left + st.w;
            tip.bottom = tip.top + st.h;
            this.renderTxttips();
        } else if (st.type === 'port') {
            st.didMove = true;
            const line = this.lines[st.li];
            if (!line || !line.pairs[st.pi]) return;
            const pair = line.pairs[st.pi];
            pair[st.side + 'LabelMoved'] = '1';
            pair[st.side + 'LabelX'] = w.x.toFixed(2);
            pair[st.side + 'LabelY'] = w.y.toFixed(2);
            const chip = this.portLayer.querySelector('.port-chip[data-side="' + st.side + '"][data-li="' + st.li + '"][data-pi="' + st.pi + '"]');
            if (chip) chip.setAttribute('transform', 'translate(' + w.x.toFixed(2) + ',' + w.y.toFixed(2) + ')');
        } else if (st.type === 'txtresize') {
            st.didMove = true;
            const tip = this.txttips[st.idx];
            if (!tip) return;
            const lines = Math.max(1, String(tip.content || '').split(/\r?\n/).length);
            const bh = Math.max(12, st.c0b - tip.top + (w.y - st.oy));
            const fs = Math.max(4, Math.min(60, Math.round((bh - 6) / lines)));
            this.layoutTxt(tip, fs);
            this.renderTxttips();
        } else if (st.type === 'portlink') {
            st.didMove = true;
            st.x = w.x; st.y = w.y;
            this.showLinkPreview(this.portAnchorFor(this.devices.get(st.sid), st.si), w.x, w.y);
        }
    }

    onMouseUp(e) {
        if (this.dragState) {
            if (this.dragState.type === 'portlink') {
                const st = this.dragState;
                this.clearLinkPreview();
                if (st.didMove) {
                    const target = this.portHitTarget(st.x, st.y);
                    if (!target || target.id === st.sid) {
                        this.setStatus('请将接口拖到目标设备的接口上以建立链路');
                    } else if (target.idx != null) {
                        this.tryConnect(st.sid, st.si, target.id, target.idx);
                    } else {
                        this.showLinkDialog(st.sid, target.id, st.si, null);
                    }
                } else {
                    this.selectDevice(st.sid);
                }
                this._preDrag = null;
                this.dragState = null;
                this.svg.style.cursor = 'grab';
                this.refreshPanel();
                return;
            }
            if (this.dragState.didMove && this._preDrag) {
                this.undoStack.push(this._preDrag);
                if (this.undoStack.length > 50) this.undoStack.shift();
                this.redoStack.length = 0;
            }
            this._preDrag = null;
            this.dragState = null;
            this.svg.style.cursor = 'grab';
            this.refreshPanel();
            this.updateDirty();
        }
    }

    onCanvasClick(e) {
        if (this._placedAt && Date.now() - this._placedAt < 350) return;
        const hit = e.target.closest('.device-group, .line-path, .line-hotspot, .txttip-group, .port-chip');
        if (!hit) this.deselectAll();
    }

    onCanvasDblClick(e) {
        const tipG = e.target.closest('.txttip-group');
        if (tipG && this.editMode) {
            const idx = parseInt(tipG.dataset.idx, 10);
            this.selectTxt(idx);
            const ta = this.propertyPanel.querySelector('.prop-txt-input');
            if (ta) ta.focus();
        }
    }

    // ---------------- 选择 / 删除 ----------------
    selectDevice(id) {
        this.cancelAll();
        this.selectedType = 'device';
        this.selectedId = id;
        this.applySelection();
        this.renderTxttips();
        this.refreshPanel();
    }

    selectLine(idx) {
        this.cancelAll();
        this.selectedType = 'line';
        this.selectedId = idx;
        this.applySelection();
        this.renderTxttips();
        this.refreshPanel();
    }

    selectTxt(idx) {
        this.cancelAll();
        this.selectedType = 'txt';
        this.selectedId = idx;
        this.applySelection();
        this.renderTxttips();
        this.refreshPanel();
    }

    deselectAll() {
        this.selectedType = null;
        this.selectedId = null;
        this.applySelection();
        this.renderTxttips();
        this.refreshPanel();
    }

    applySelection() {
        this.devicesLayer.querySelectorAll('.device-group').forEach(el => el.classList.toggle('selected', this.selectedType === 'device' && el.dataset.id === this.selectedId));
        this.linesLayer.querySelectorAll('.line-path').forEach(el => el.classList.toggle('selected', this.selectedType === 'line' && el.getAttribute('data-line-idx') === String(this.selectedId)));
        this.labelsLayer.querySelectorAll('.txttip-group').forEach(el => el.classList.toggle('selected', this.selectedType === 'txt' && el.dataset.idx === String(this.selectedId)));
        this.deviceList.querySelectorAll('.device-item').forEach(el => el.classList.toggle('active', this.selectedType === 'device' && el.dataset.id === this.selectedId));
        const hi = new Set();
        if (this.selectedType === 'line') {
            const l = this.lines[this.selectedId];
            if (l) { hi.add(l.srcDeviceID); hi.add(l.destDeviceID); }
        }
        this.devicesLayer.querySelectorAll('.device-group').forEach(el => el.classList.toggle('li-hi', hi.has(el.dataset.id)));
    }

    deleteSelection() {
        if (!this.editMode) { this.setStatus('请先开启编辑模式再删除', 'error'); return; }
        if (this.selectedType === 'device') this.deleteDevice(this.selectedId);
        else if (this.selectedType === 'line') this.deleteLine(this.selectedId);
        else if (this.selectedType === 'txt') this.deleteTxt(this.selectedId);
    }

    deleteDevice(id) {
        const name = this.devices.get(id) ? this.devices.get(id).name : '';
        this.pushHistory();
        this.devices.delete(id);
        this.lines = this.lines.filter(l => l.srcDeviceID !== id && l.destDeviceID !== id);
        this.deselectAll();
        this.render();
        this.setStatus('已删除设备 ' + name + ' 及其链路');
    }

    deleteLine(idx) {
        this.pushHistory();
        this.lines.splice(idx, 1);
        this.deselectAll();
        this.render();
        this.setStatus('已删除链路');
    }

    deleteTxt(idx) {
        this.pushHistory();
        this.txttips.splice(idx, 1);
        this.deselectAll();
        this.render();
        this.setStatus('已删除注释');
    }

    // ---------------- 连线 ----------------
    lineHitDevice(id) {
        if (this.lineSourceId === null) {
            this.lineSourceId = { id, idx: null };
            this.setHint('请点击另一台设备作为目标');
            this.devicesLayer.querySelectorAll('.device-group').forEach(el => el.classList.toggle('linked', el.dataset.id === id));
        } else if (this.lineSourceId.id === id) {
            this.cancelLine();
        } else {
            this.showLinkDialog(this.lineSourceId.id, id, this.lineSourceId.idx, null);
        }
    }

    // 连线工具下点击“所有接口”中的具体接口：指定源/目标接口
    lineHitPort(id, idx) {
        if (this.lineSourceId === null) {
            this.lineSourceId = { id, idx };
            this.setHint('已选源接口，请点击目标设备的接口');
            this.devicesLayer.querySelectorAll('.device-group').forEach(el => el.classList.toggle('linked', el.dataset.id === id));
        } else if (this.lineSourceId.id === id) {
            this.cancelLine();
        } else {
            const src = this.lineSourceId;
            this.showLinkDialog(src.id, id, src.idx, idx);
        }
    }

    cancelLine() {
        this.lineSourceId = null;
        this.setHint('');
        this.devicesLayer.querySelectorAll('.device-group').forEach(el => el.classList.remove('linked'));
    }

    // 两端接口位置（所有接口展示的锚点）
    portAnchorFor(dev, idx) { return this.ifaceSlotPos(dev, idx); }

    // 命中检测：优先命中的接口锚点，其次设备本体
    portHitTarget(x, y) {
        let best = null;
        this.portsLayer.querySelectorAll('.all-port').forEach(ap => {
            const tx = parseFloat(ap.getAttribute('data-x')), ty = parseFloat(ap.getAttribute('data-y'));
            if (isFinite(tx) && Math.hypot(x - tx, y - ty) < 10) best = { id: ap.dataset.id, idx: parseInt(ap.dataset.idx, 10) };
        });
        if (best) return best;
        this.devices.forEach(dev => {
            if (x >= dev.cx - 52 && x <= dev.cx + 52 && y >= dev.cy - 36 && y <= dev.cy + 36) best = { id: dev.id, idx: null };
        });
        return best;
    }

    // 两端（可含具体接口）尽量建链；成功返回 true
    tryConnect(sid, si, did, di) {
        const sd = this.devices.get(sid), dd = this.devices.get(did);
        if (!sd || !dd) { this.setStatus('设备不存在', 'error'); return false; }
        if (si != null && di != null) {
            const fi = sd.ifaces[si], fj = dd.ifaces[di];
            if (fi.family !== fj.family) { this.setStatus('两端接口类型不匹配：' + fi.name + ' / ' + fj.name, 'error'); return false; }
            const need = this.pendingCable ? (CABLE_TYPES[this.pendingCable] || {}).fam : null;
            if (need && fi.family !== need) { this.setStatus('所选【' + (CABLE_TYPES[this.pendingCable] || { label: this.pendingCable }).label + '】不能用于该接口', 'error'); return false; }
            if (this.usedIndexSet(sd).has(si)) { this.setStatus('源接口 ' + fi.name + ' 已被占用', 'error'); return false; }
            if (this.usedIndexSet(dd).has(di)) { this.setStatus('目的接口 ' + fj.name + ' 已被占用', 'error'); return false; }
            this.createLine(sid, did, si, di, this.lineNameFor(fi.family));
            return true;
        }
        return false;
    }

    showLinkPreview(p1, p2) {
        this.clearLinkPreview();
        mkEl('path', { 'class': 'preview-line', d: 'M ' + p1[0] + ' ' + p1[1] + ' L ' + p2[0] + ' ' + p2[1] }, this.previewLayer);
    }

    clearLinkPreview() {
        this.previewLayer.querySelectorAll('.preview-line').forEach(p => p.remove());
    }

    showLinkDialog(sid, did, siPreset, diPreset) {
        const sd = this.devices.get(sid), dd = this.devices.get(did);
        if (!sd || !dd) return;
        // 两端都指定了具体接口且直接可连 → 立即建链（与 eNSP 端口拖拽一致）
        if (siPreset != null && diPreset != null && this.tryConnect(sid, siPreset, did, diPreset)) return;
        this.linkState = { sid, did, family: null };
        document.getElementById('linkModalDesc').textContent = (sd.name || '?') + '  →  ' + (dd.name || '?');
        const constraint = this.pendingCable ? (CABLE_TYPES[this.pendingCable] || {}).fam : null;
        const cableL = this.pendingCable && CABLE_TYPES[this.pendingCable] ? CABLE_TYPES[this.pendingCable].label : null;
        const famMap = {
            'net': (cableL && constraint === 'net' ? cableL + '（以太网）' : 'Copper（以太网）'),
            'serial': (cableL && constraint === 'serial' ? cableL + '（串口）' : 'Serial（串口）'),
            'wlan': 'Wlan（无线）'
        };
        const suFree = this.freeIndices(sd), duFree = this.freeIndices(dd);
        const famAvail = {};
        ['net', 'serial', 'wlan'].forEach(f => famAvail[f] = suFree.some(i => sd.ifaces[i].family === f) && duFree.some(i => dd.ifaces[i].family === f));
        const typeSel = document.getElementById('linkType');
        typeSel.innerHTML = '';
        let defaultFam = null;
        ['net', 'serial', 'wlan'].forEach(f => {
            const ok = famAvail[f] && (!constraint || constraint === f);
            const o = document.createElement('option');
            o.value = f;
            o.textContent = famMap[f] + (ok ? '' : '（不可用）');
            o.disabled = !ok;
            if (ok && defaultFam === null) defaultFam = f;
            typeSel.appendChild(o);
        });
        if (!defaultFam) {
            this.setStatus('两台设备没有可直接匹配的同类接口', 'error');
            this.cancelLine();
            return;
        }
        this.linkState.family = defaultFam;
        typeSel.value = defaultFam;
        this.populateLinkSels();
        // 预设选择指定接口（若空闲）
        const sSel = document.getElementById('linkSrcSel');
        const dSel = document.getElementById('linkDstSel');
        if (siPreset != null && suFree.includes(siPreset)) { sSel.value = String(siPreset); }
        if (diPreset != null && duFree.includes(diPreset)) { dSel.value = String(diPreset); }
        document.getElementById('linkModal').style.display = 'flex';
        this.setStatus('请选择线缆类型与两端接口');
    }

    addAutoOpt(sel) {
        const o = document.createElement('option');
        o.value = 'auto';
        o.textContent = '（自动）';
        sel.appendChild(o);
    }

    populateLinkSels() {
        if (!this.linkState) return;
        const { sid, did, family } = this.linkState;
        const sd = this.devices.get(sid), dd = this.devices.get(did);
        if (!sd || !dd) return;
        const su = this.freeIndices(sd).filter(i => sd.ifaces[i].family === family);
        const du = this.freeIndices(dd).filter(i => dd.ifaces[i].family === family);
        const s1 = document.getElementById('linkSrcSel'), s2 = document.getElementById('linkDstSel');
        s1.innerHTML = ''; s2.innerHTML = '';
        this.addAutoOpt(s1); this.addAutoOpt(s2);
        su.forEach(i => { const o = document.createElement('option'); o.value = i; o.textContent = sd.ifaces[i].name; s1.appendChild(o); });
        du.forEach(i => { const o = document.createElement('option'); o.value = i; o.textContent = dd.ifaces[i].name; s2.appendChild(o); });
        document.getElementById('linkSrcLabel').textContent = '源接口 (' + (sd.name || '') + ')';
        document.getElementById('linkDstLabel').textContent = '目的接口 (' + (dd.name || '') + ')';
    }

    commitLink() {
        const ls = this.linkState;
        if (!ls) return;
        const sd = this.devices.get(ls.sid), dd = this.devices.get(ls.did);
        if (!sd || !dd) return;
        const su = this.freeIndices(sd).filter(i => sd.ifaces[i].family === ls.family);
        const du = this.freeIndices(dd).filter(i => dd.ifaces[i].family === ls.family);
        const v1 = document.getElementById('linkSrcSel').value;
        const v2 = document.getElementById('linkDstSel').value;
        let si = v1 === 'auto' ? su[0] : parseInt(v1, 10);
        let di = v2 === 'auto' ? du[0] : parseInt(v2, 10);
        if (si == null || di == null || isNaN(si) || isNaN(di)) { this.setStatus('该类型下没有可用接口', 'error'); return; }
        if (si === di && ls.sid === ls.did) { this.setStatus('不能使用同一接口', 'error'); return; }
        if (!su.includes(si)) { const alt = su[0]; if (alt == null) { this.setStatus('源接口已被占用', 'error'); return; } si = alt; }
        if (!du.includes(di)) { const alt = du[0]; if (alt == null) { this.setStatus('目的接口已被占用', 'error'); return; } di = alt; }
        this.createLine(ls.sid, ls.did, si, di, this.lineNameFor(ls.family));
    }

    createLine(sid, did, si, di, ln) {
        const sd = this.devices.get(sid), dd = this.devices.get(did);
        if (!sd || !dd) return;
        const usedS = this.usedIndexSet(sd), usedD = this.usedIndexSet(dd);
        if (usedS.has(si) || usedD.has(di)) { this.setStatus('该接口已被占用，请选择其他接口', 'error'); this.closeLinkModal(); this.cancelLine(); return; }
        this.pushHistory();
        const pair = { lineName: ln, srcIndex: si, tarIndex: di,
            srcBoundRectIsMoved: '0', srcBoundRect_X: '0', srcBoundRect_Y: '0', srcOffset_X: '0', srcOffset_Y: '0',
            tarBoundRectIsMoved: '0', tarBoundRect_X: '0', tarBoundRect_Y: '0', tarOffset_X: '0', tarOffset_Y: '0' };
        this.lines.push({ attrs: {}, srcDeviceID: sid, destDeviceID: did, pairs: [pair] });
        this.closeLinkModal();
        this.cancelLine();
        this.deselectAll();
        this.render();
        this.setStatus('已建立 ' + ln + ' 链路');
    }

    closeLinkModal() {
        document.getElementById('linkModal').style.display = 'none';
        this.linkState = null;
    }

    updateLines() { this.updateLinesFor(null); }

    // 仅重绘涉及指定设备（或全部）的连线，避免整层大面积重绘
    updateLinesFor(id) {
        this.lines.forEach((line, li) => {
            if (id && line.srcDeviceID !== id && line.destDeviceID !== id) return;
            (line.pairs || []).forEach((pair, pi) => this.redrawPair(li, pi));
        });
    }

    // ---------------- 新增设备 ----------------
    beginPlace(tpl) {
        this.ensureStarted();
        this.enableEdit();
        this.cancelAll();
        this.pendingAddTpl = tpl;
        this.pendingAddId = 'dev:' + uuidv4();
        this.activeTool = 'select';
        this.setToolButtonClasses();
        this.setHint('点击画布放置 ' + tpl.model + '（Esc 取消）');
    }

    showGhost(x, y) {
        this.clearGhost();
        const t = this.pendingAddTpl;
        if (!t) return;
        const g = mkEl('g', { 'class': 'preview-device', transform: 'translate(' + x + ',' + y + ')' });
        mkEl('rect', { x: -52, y: -36, width: 104, height: 72, fill: '#faf9f5', stroke: '#c96442', 'stroke-width': 2, 'stroke-dasharray': '5 4' }, g);
        const href = this.deviceIcon(t.model);
        if (href) mkEl('image', { href, x: -18, y: -26, width: 40, height: 40 }, g);
        this.previewLayer.appendChild(g);
    }

    clearGhost() { while (this.previewLayer.firstChild) this.previewLayer.removeChild(this.previewLayer.firstChild); }

    placePending(x, y) {
        const tpl = this.pendingAddTpl;
        if (!tpl) { this.cancelAll(); return; }
        this.pushHistory();
        const pre = tpl.prefix || 'Dev';
        const n = (this._nameCounts[pre] || 0) + 1;
        this._nameCounts[pre] = n;
        const name = pre + n;
        const id = uuidv4();
        const slots = [{ attrs: { number: 'slot17', isMainBoard: '1' }, interfaces: tpl.imp.map(it => ({ interfacename: it[0], sztype: familyOf(it[0]) === 'serial' ? 'Serial' : (familyOf(it[0]) === 'wlan' ? 'Wlan' : 'Ethernet'), count: it[1] })) }];
        const dev = { attrs: {}, id, name, model: tpl.model, cx: x, cy: y, slots, system_mac: this.randomMac(), com_port: String(this.maxComPort() + 1) };
        dev.ifaces = this.expandIfaces(dev);
        this.devices.set(id, dev);
        this.clearGhost();
        this._placedAt = Date.now();
        this.setHint('点击空白处继续添加 ' + tpl.model + '（右键结束）');
        this.render();
        this.setStatus('已添加 ' + name + '（' + tpl.model + '）');
    }

    // 首次打开尚未新建/加载时，自动初始化一个空白拓扑，省去先点“新建”这一步
    ensureStarted() {
        if (!this._topologyStarted) this.newTopo();
    }

    // ---------------- 新增注释 ----------------
    beginTxt() {
        this.ensureStarted();
        this.enableEdit();
        this.cancelAll();
        this.pendingTxt = true;
        this.activeTool = 'select';
        this.setToolButtonClasses();
        this.setHint('点击画布放置注释（右键结束）');
    }

    placeTxt(x, y) {
        this.pushHistory();
        const tip = { left: x, top: y, right: x + 60, bottom: y + 20, content: '注释', txtcolor: -16777216, txtbkcolor: -2331 };
        this.txttips.push(tip);
        this.layoutTxt(tip);
        this._placedAt = Date.now();
        this.selectedType = 'txt';
        this.selectedId = this.txttips.length - 1;
        this.applySelection();
        this.renderTxttips();
        this.refreshPanel();
        this.setHint('点击空白处继续添加注释（右键结束）');
        this.setStatus('已添加注释，可在右侧修改内容');
        const ta = this.propertyPanel.querySelector('.prop-txt-input');
        if (ta) ta.focus();
    }

    randomMac() {
        const h = () => Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0');
        return '00-E0-FC-' + h() + '-' + h() + '-' + h();
    }

    maxComPort() {
        let mx = 2000;
        this.devices.forEach(d => { const v = parseInt(d.com_port || d.attrs.com_port, 10); if (!isNaN(v) && v > mx) mx = v; });
        return mx;
    }

    // ---------------- 取消 ----------------
    cancelAll() {
        if (this.pendingCable) { this.pendingCable = null; this.renderPalette(); }
        this.pendingAddTpl = null;
        this.pendingAddId = null;
        this.pendingTxt = false;
        this.clearGhost();
        this.cancelLine();
    }

    // ---------------- 撤回 / 恢复 ----------------
    jsonDeep(v) { return JSON.parse(JSON.stringify(v)); }

    snapshot() {
        return {
            devices: Array.from(this.devices).map(([id, d]) => [id, this.jsonDeep(d)]),
            lines: this.jsonDeep(this.lines),
            txttips: this.jsonDeep(this.txttips),
            topoVersion: this.topoVersion
        };
    }

    restore(s) {
        this.devices = new Map(s.devices.map(([id, d]) => {
            if (d.ifaces) d.ifaces = this.expandIfaces(d);
            return [id, d];
        }));
        this.lines = s.lines;
        this.txttips = s.txttips;
        this.topoVersion = s.topoVersion;
        this.updateNameCounter();
        this.deselectAll();
        this.render();
    }

    pushHistory() {
        this.undoStack.push(this.snapshot());
        if (this.undoStack.length > 50) this.undoStack.shift();
        this.redoStack.length = 0;
    }

    snapKey() { return JSON.stringify(this.snapshot()); }

    // 比较当前状态与上次保存/加载的状态，未保存时让保存按钮变色
    updateDirty() {
        const dirty = this._savedSnap != null && this._savedSnap !== this.snapKey();
        if (dirty !== this.dirty) {
            this.dirty = dirty;
            const b = document.getElementById('btnSave');
            if (b) b.classList.toggle('dirty', dirty);
        }
    }

    markClean() {
        this._savedSnap = this.snapKey();
        this.updateDirty();
    }

    undo() {
        if (!this.undoStack.length) { this.setStatus('没有可撤回的操作'); return; }
        this.redoStack.push(this.snapshot());
        const s = this.undoStack.pop();
        this.restore(s);
        this.setStatus('已撤回');
    }

    redo() {
        if (!this.redoStack.length) { this.setStatus('没有可恢复的操作'); return; }
        this.undoStack.push(this.snapshot());
        const s = this.redoStack.pop();
        this.restore(s);
        this.setStatus('已恢复');
    }

    // ---------------- 属性面板 ----------------
    refreshPanel() {
        if (this.selectedType === 'device') this.propertyPanel.innerHTML = this.devicePanel(this.devices.get(this.selectedId));
        else if (this.selectedType === 'line') this.propertyPanel.innerHTML = this.linePanel(this.selectedId);
        else if (this.selectedType === 'txt') {
            this.propertyPanel.innerHTML = this.txtPanel(this.txttips[this.selectedId]);
            const t = this.txttips[this.selectedId];
            if (t) { this.layoutTxt(t); const inp = document.getElementById('allTxtFontSize'); if (inp) inp.value = t.fontsize; }
        }
        else this.propertyPanel.innerHTML = '<p class="empty-hint">选择设备 / 链路 / 注释查看详情</p>';
        this.bindPanelEvents();
    }

    // 同时设置所有注释的字号大小
    setAllTxtFontSize(fs) {
        if (!(fs > 0) || fs < 4 || fs > 60) { this.setStatus('字号需在 4~60 之间', 'error'); return; }
        if (!this.txttips.length) { this.setStatus('当前没有注释可设置'); return; }
        this.pushHistory();
        this.txttips.forEach(t => { t.fontsize = fs; this.layoutTxt(t); });
        this.renderTxttips();
        this.refreshPanel();
        this.setStatus('已将全部注释字号设为 ' + fs + ' px');
    }

    devicePanel(dev) {
        if (!dev) return '<p class="empty-hint">选择设备查看详情</p>';
        let h = '<div class="property-section"><h4>基本信息</h4>';
        h += '<div class="property-row"><span class="property-label">名称</span>';
        if (this.editMode) h += '<input class="property-input prop-name" value="' + escHTML(dev.name) + '">';
        else h += '<span class="property-value">' + escHTML(dev.name) + '</span>';
        h += '</div>';
        h += '<div class="property-row"><span class="property-label">型号</span><span class="property-value">' + escHTML(dev.model) + '</span></div>';
        h += '<div class="property-row"><span class="property-label">COM</span><span class="property-value">' + escHTML(dev.com_port || dev.attrs.com_port || '') + '</span></div>';
        h += '<div class="property-row"><span class="property-label">坐标</span><span class="property-value">(' + dev.cx.toFixed(1) + ', ' + dev.cy.toFixed(1) + ')</span></div>';
        if (this.editMode) {
            h += '<div class="property-row"><span class="property-label">X</span><input class="property-input prop-x" value="' + Math.round(dev.cx) + '"></div>';
            h += '<div class="property-row"><span class="property-label">Y</span><input class="property-input prop-y" value="' + Math.round(dev.cy) + '"></div>';
            h += '<button class="btn-danger prop-delete"><svg class="btn-icon" style="margin-right:4px"><use href="#icon-trash"/></svg>删除设备</button>';
        }
        h += '</div>';
        const usedIdx = this.usedIndexSet(dev);
        h += '<div class="property-section"><h4>接口</h4><div class="interface-list">';
        if (!dev.ifaces.length) h += '<div class="interface-item">（无）</div>';
        dev.ifaces.forEach(it => {
            h += '<div class="interface-item' + (usedIdx.has(it.index) ? ' used' : '') + '"><span class="interface-type">' + escHTML(it.name) + '</span></div>';
        });
        h += '</div></div>';

        const rels = this.lines.filter(l => l.srcDeviceID === dev.id || l.destDeviceID === dev.id).map(l => this.lines.indexOf(l));
        if (rels.length) {
            h += '<div class="property-section"><h4>相关链路 (' + rels.length + ')</h4>';
            rels.forEach(li => {
                const l = this.lines[li];
                const otherId = l.srcDeviceID === dev.id ? l.destDeviceID : l.srcDeviceID;
                const other = this.devices.get(otherId);
                const types = (l.pairs || []).map(p => p.lineName).join(' / ');
                h += '<div class="property-row"><span class="property-label">' + (other ? escHTML(other.name) : '?') + '</span><span class="property-value" style="cursor:pointer" data-select-line="' + li + '">' + escHTML(types) + '</span></div>';
            });
            h += '</div>';
        }
        return h;
    }

    txtPanel(t) {
        if (!t) return '<p class="empty-hint">选择注释查看/编辑</p>';
        this.layoutTxt(t);
        const fg = intToColor(t.txtcolor != null ? t.txtcolor : -16777216);
        const bg = intToColor(t.txtbkcolor != null ? t.txtbkcolor : -2331);
        let h = '<div class="property-section"><h4>注释内容</h4>';
        if (this.editMode) h += '<div class="property-row col"><textarea class="property-input prop-txt-input" rows="4">' + escHTML(t.content || '') + '</textarea></div>';
        else h += '<div class="property-row col"><pre class="property-value prop-txt-view">' + escHTML(t.content || '') + '</pre></div>';
        h += '<div class="property-row"><span class="property-label">位置</span><span class="property-value">(' + t.left.toFixed(1) + ', ' + t.top.toFixed(1) + ')</span></div>';
        h += '<div class="property-row"><span class="property-label">字号</span>' +
            (this.editMode
                ? '<input class="property-input prop-txt-size" type="number" min="4" max="60" step="1" value="' + t.fontsize + '">'
                : '<span class="property-value">' + t.fontsize + ' px</span>') + '</div>';
        h += '<div class="property-row"><span class="property-label">文字颜色</span>' +
            (this.editMode
                ? '<input class="property-input prop-txt-color" type="color" value="' + fg + '">'
                : '<span class="color-swatch" style="background:' + fg + '"></span><span class="property-value">' + fg + '</span>') + '</div>';
        h += '<div class="property-row"><span class="property-label">底色</span>' +
            (this.editMode
                ? '<input class="property-input prop-txt-bg" type="color" value="' + bg + '">'
                : '<span class="color-swatch" style="background:' + bg + '"></span><span class="property-value">' + bg + '</span>') + '</div>';
        if (this.editMode) h += '<button class="btn-danger prop-delete-txt"><svg class="btn-icon" style="margin-right:4px"><use href="#icon-trash"/></svg>删除注释</button>';
        h += '</div>';
        return h;
    }

    usedIndexSet(dev) {
        const set = new Set();
        this.lines.forEach(l => l.pairs.forEach(p => {
            if (l.srcDeviceID === dev.id) set.add(p.srcIndex);
            if (l.destDeviceID === dev.id) set.add(p.tarIndex);
        }));
        return set;
    }

    linePanel(idx) {
        const line = this.lines[idx];
        if (!line) return '<p class="empty-hint">没有这条链路</p>';
        const s = this.devices.get(line.srcDeviceID), d = this.devices.get(line.destDeviceID);
        let h = '<div class="property-section"><h4>链路信息</h4>';
        h += '<div class="property-row"><span class="property-label">源端</span><span class="property-value">' + (s ? escHTML(s.name) : '?') + '</span></div>';
        h += '<div class="property-row"><span class="property-label">目的端</span><span class="property-value">' + (d ? escHTML(d.name) : '?') + '</span></div>';
        (line.pairs || []).forEach(p => {
            const ns = s && s.ifaces[p.srcIndex] ? s.ifaces[p.srcIndex].name : 'Port' + p.srcIndex;
            const nd = d && d.ifaces[p.tarIndex] ? d.ifaces[p.tarIndex].name : 'Port' + p.tarIndex;
            h += '<div class="property-row"><span class="property-label">接口</span><span class="property-value">' + escHTML(ns) + ' → ' + escHTML(nd) + ' (' + escHTML(p.lineName) + ')</span></div>';
        });
        h += '</div>';
        if (this.editMode) h += '<button class="btn-danger prop-delete-line"><svg class="btn-icon" style="margin-right:4px"><use href="#icon-trash"/></svg>删除此链路</button>';
        return h;
    }

    bindPanelEvents() {
        this.propertyPanel.querySelectorAll('.prop-name').forEach(inp => inp.addEventListener('change', () => {
            const d = this.devices.get(this.selectedId);
            if (!d || inp.value === d.name) return;
            this.pushHistory();
            d.name = inp.value; if (d.attrs) d.attrs.name = inp.value;
            this.render();
        }));
        this.propertyPanel.querySelectorAll('.prop-x').forEach(inp => inp.addEventListener('change', () => {
            const d = this.devices.get(this.selectedId);
            if (!d) return;
            const v = parseFloat(inp.value); if (isNaN(v)) return;
            this.pushHistory();
            d.cx = v;
            this.render();
        }));
        this.propertyPanel.querySelectorAll('.prop-y').forEach(inp => inp.addEventListener('change', () => {
            const d = this.devices.get(this.selectedId);
            if (!d) return;
            const v = parseFloat(inp.value); if (isNaN(v)) return;
            this.pushHistory();
            d.cy = v;
            this.render();
        }));
        this.propertyPanel.querySelectorAll('.prop-txt-input').forEach(ta => {
            ta.addEventListener('input', () => {
            const t = this.txttips[this.selectedId];
            if (!t) return;
            t.content = ta.value;
            this.layoutTxt(t);
            this.renderTxttips();
            });
            ta.addEventListener('change', () => this.pushHistory());
        });
        this.propertyPanel.querySelectorAll('.prop-txt-size').forEach(inp => inp.addEventListener('change', () => {
            const t = this.txttips[this.selectedId];
            if (!t) return;
            const v = parseFloat(inp.value);
            if (isNaN(v) || v < 4 || v > 60) return;
            this.pushHistory();
            t.fontsize = v;
            this.layoutTxt(t);
            this.renderTxttips();
        }));
        this.propertyPanel.querySelectorAll('.prop-txt-color').forEach(inp => inp.addEventListener('change', () => {
            const t = this.txttips[this.selectedId];
            if (!t) return;
            this.pushHistory();
            t.txtcolor = colorToInt(inp.value);
            this.renderTxttips();
        }));
        this.propertyPanel.querySelectorAll('.prop-txt-bg').forEach(inp => inp.addEventListener('change', () => {
            const t = this.txttips[this.selectedId];
            if (!t) return;
            this.pushHistory();
            t.txtbkcolor = colorToInt(inp.value);
            this.renderTxttips();
        }));
        this.propertyPanel.querySelectorAll('.prop-delete').forEach(b => b.addEventListener('click', () => this.deleteDevice(this.selectedId)));
        this.propertyPanel.querySelectorAll('.prop-delete-line').forEach(b => b.addEventListener('click', () => this.deleteLine(this.selectedId)));
        this.propertyPanel.querySelectorAll('.prop-delete-txt').forEach(b => b.addEventListener('click', () => this.deleteTxt(this.selectedId)));
        this.propertyPanel.querySelectorAll('[data-select-line]').forEach(b => b.addEventListener('click', () => this.selectLine(parseInt(b.getAttribute('data-select-line'), 10))));
    }

    // ---------------- 设备面板 ----------------
    // 添加设备连线（eNSP“设备连线”分类）：连线本质上也是“设备”，从添加设备面板选中后进入连线模式
    pickCable(k) {
        this.enableEdit();
        this.cancelAll();
        this.pendingCable = k;
        this.activeTool = 'line';
        this.setToolButtonClasses();
        this.renderPalette();
        const c = CABLE_TYPES[k] || { label: k };
        this.setStatus('已选择【' + c.label + '】：依次点击两台设备的接口/设备以添加连线');
    }

    // 线缆名：指定连线时使用所选线名（与 eNSP lineName 一致），否则按接口家族自动决定
    lineNameFor(fam) {
        if (this.pendingCable) return this.pendingCable;
        return lineNameOf(fam);
    }

    renderPalette() {
        this.palette.innerHTML = '';
        const addHeader = (label) => {
            const catEl = document.createElement('div');
            catEl.className = 'palette-cat';
            const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            arrow.setAttribute('class', 'palette-cat-arrow chev-icon');
            arrow.setAttribute('viewBox', '0 0 24 24');
            arrow.innerHTML = '<use href="#icon-chevron"/>';
            const txt = document.createElement('span');
            txt.textContent = label;
            catEl.appendChild(arrow);
            catEl.appendChild(txt);
            catEl.title = '点击收起 / 展开';
            return catEl;
        };
        // 每个分类一个分组：分类标题 + 可折叠的条目容器
        const startGroup = (label) => {
            const grp = document.createElement('div');
            grp.className = 'palette-group';
            const catEl = addHeader(label);
            catEl.addEventListener('click', () => {
                const collapsed = grp.classList.toggle('collapsed');
                this.paletteCollapsed[label] = collapsed;
            });
            grp.appendChild(catEl);
            const itemsEl = document.createElement('div');
            itemsEl.className = 'palette-cat-items';
            grp.appendChild(itemsEl);
            this.palette.appendChild(grp);
            if (this.paletteCollapsed[label]) grp.classList.add('collapsed');
            return itemsEl;
        };
        const addCableItem = (itemsEl, k) => {
            const c = CABLE_TYPES[k] || { label: k };
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'palette-item palette-cable' + (this.pendingCable === k ? ' active' : '');
            item.dataset.cable = k;
            item.title = '选择 ' + c.label + '：依次点击两台设备的接口/设备添加连线';
            const col = c.color || '#9b988c';
            item.innerHTML =
                '<svg class="cable-icon" viewBox="0 0 24 14" width="24" height="14" aria-hidden="true">' +
                '<path d="M3 11 L21 3" stroke="' + col + '" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
                '<rect x="1" y="9" width="5" height="5" rx="1.2" fill="' + col + '"/>' +
                '<rect x="18" y="0" width="5" height="5" rx="1.2" fill="' + col + '"/>' +
                '</svg>' +
                '<span>' + c.label + '</span>';
            item.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); this.pickCable(k); });
            item.addEventListener('pointerdown', (ev) => ev.stopPropagation());
            itemsEl.appendChild(item);
        };
        const addModelItem = (itemsEl, model) => {
            const tpl = TEMPLATES[model] || { model, prefix: (model.match(/^[A-Za-z]+/) || [model])[0], imp: [['GE', 4]] };
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'palette-item';
            item.title = '点击放置 ' + model + '（需开启编辑）';
            const href = this.deviceIcon(model);
            if (href) {
                const img = document.createElement('img');
                img.src = href;
                img.alt = '';
                img.onerror = () => { img.style.display = 'none'; };
                item.appendChild(img);
            }
            const span = document.createElement('span');
            span.textContent = model;
            item.appendChild(span);
            item.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); this.beginPlace(tpl); });
            item.addEventListener('pointerdown', (ev) => ev.stopPropagation());
            itemsEl.appendChild(item);
        };

        // 常用分类（置顶，仅含指定设备与连线）
        let el = startGroup(COMMON_ITEMS.label);
        COMMON_ITEMS.items.forEach(it => { if (it.cable) addCableItem(el, it.cable); else addModelItem(el, it.model); });

        // 设备分类（与 items.xml 完全一致）
        DEVICE_CATALOG.forEach(group => {
            el = startGroup(group.label);
            if (group.cables) { group.cables.forEach(k => addCableItem(el, k)); return; }
            group.models.forEach(model => addModelItem(el, model));
        });
    }

    // ---------------- 序列化 / 编码 / 保存 ----------------
    serialize() {
        const NL = '\r\n';
        let out = '<?xml version="1.0" encoding="UNICODE" ?>' + NL + '<topo' + (this.topoVersion ? ' version="' + xmlAttr(this.topoVersion) + '"' : '') + '>' + NL;
        out += '    <devices>' + NL;
        this.devices.forEach(dev => {
            const a = Object.assign({}, dev.attrs || {});
            a.model = dev.model; a.name = dev.name;
            if (!('id' in a) && dev.id) a.id = dev.id;
            if (!('settings' in a)) a.settings = '';
            if (!('bootmode' in a)) a.bootmode = '0';
            if (!('com_port' in a) && dev.com_port != null) a.com_port = dev.com_port;
            if (!('system_mac' in a) && dev.system_mac) a.system_mac = dev.system_mac;
            let attrText = '';
            for (const k of ['id', 'name', 'poe', 'model', 'settings', 'system_mac', 'com_port', 'bootmode']) if (k in a) attrText += ' ' + k + '="' + xmlAttr(a[k]) + '"';
            for (const k in a) if (!['id', 'name', 'poe', 'model', 'settings', 'system_mac', 'com_port', 'bootmode', 'cx', 'cy', 'edit_left', 'edit_top'].includes(k)) attrText += ' ' + k + '="' + xmlAttr(a[k]) + '"';
            const editL = (a.edit_left !== undefined) ? a.edit_left : Math.round(dev.cx + 27);
            const editT = (a.edit_top !== undefined) ? a.edit_top : Math.round(dev.cy + 54);
            out += '        <dev' + attrText + ' cx="' + dev.cx.toFixed(6) + '" cy="' + dev.cy.toFixed(6) + '" edit_left="' + editL + '" edit_top="' + editT + '">' + NL;
            (dev.slots || []).forEach(slot => {
                let sat = '';
                for (const k in (slot.attrs || {})) sat += ' ' + k + '="' + xmlAttr(slot.attrs[k]) + '"';
                const haveIface = (slot.interfaces || []).length || (slot.extras || []).length;
                if (!haveIface) { out += '            <slot' + sat + ' />' + NL; return; }
                out += '            <slot' + sat + '>' + NL;
                (slot.interfaces || []).forEach(ic => {
                    out += '                <interface sztype="' + xmlAttr(ic.sztype || 'Ethernet') + '" interfacename="' + xmlAttr(ic.interfacename || 'GE') + '" count="' + (ic.count || 0) + '" />' + NL;
                });
                (slot.extras || []).forEach(m => {
                    let mt = '';
                    for (const k in m) mt += ' ' + k + '="' + xmlAttr(m[k] || '') + '"';
                    out += '                <interfaceMap' + mt + ' />' + NL;
                });
                out += '            </slot>' + NL;
            });
            out += '        </dev>' + NL;
        });
        out += '    </devices>' + NL;
        out += '    <lines>' + NL;
        this.lines.forEach(line => {
            out += '        <line srcDeviceID="' + xmlAttr(line.srcDeviceID) + '" destDeviceID="' + xmlAttr(line.destDeviceID) + '">' + NL;
            (line.pairs || []).forEach(p => {
                let pt = '';
                for (const k in p) pt += ' ' + k + '="' + xmlAttr(String(p[k])) + '"';
                out += '            <interfacePair' + pt + ' />' + NL;
            });
            out += '        </line>' + NL;
        });
        out += '    </lines>' + NL;
        let shLine = this.shapesRaw || '<shapes />';
        if (!/\n/.test(shLine)) shLine = shLine.replace(/<shapes\s*\/>$/i, '<shapes />');
        out += '    ' + shLine + NL;
        out += '    <txttips>' + NL;
        this.txttips.forEach(t => {
            let pt = '';
            for (const k in t) if (k.charCodeAt(0) !== 95 && k !== 'fontsize') pt += ' ' + k + '="' + xmlAttr(String(t[k])) + '"';
            out += '        <txttip' + pt + ' />' + NL;
        });
        out += '    </txttips>' + NL;
        out += '</topo>' + NL;
        return out;
    }

    encodeGbk(text) {
        const tab = window.GBK_ENCODE_TABLE || {};
        const bytes = [];
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const c = ch.codePointAt(0);
            if (c < 0x80) { bytes.push(c); continue; }
            const hex = tab[ch];
            if (hex) for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.substr(k, 2), 16));
            else bytes.push(0x3f);
        }
        return new Uint8Array(bytes);
    }

    async save(force) {
        const xml = this.serialize();
        const bytes = this.encodeGbk(xml);
        if (!force && this.fsHandle) {
            try {
                const w = await this.fsHandle.createWritable();
                await w.write(new Blob([bytes], { type: 'application/xml' }));
                await w.close();
                this.markClean();
                this.setStatus('已保存: ' + this.fileNameStr);
                return;
            } catch (e) { }
        }
        this.pickSave(bytes);
    }

    async pickSave(bytes) {
        const suggested = this.fileNameStr || 'topo.topo';
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({ types: [{ description: 'eNSP 拓扑', accept: { 'application/xml': ['.topo'] } }], suggestedName: suggested });
                const w = await handle.createWritable();
                await w.write(new Blob([bytes], { type: 'application/xml' }));
                await w.close();
                this.fsHandle = handle;
                this.markClean();
                this.setStatus('已保存: ' + (handle.name || suggested));
                return;
            } catch (err) { if (err && err.name === 'AbortError') return; }
        }
        const blob = new Blob([bytes], { type: 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = suggested;
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 300);
        this.markClean();
        this.setStatus('已下载: ' + suggested);
    }

    updateCounts() {
        this.deviceCountEl.textContent = this.devices.size;
        this.lineCountEl.textContent = this.lines.length;
    }

    updateNameCounter() {
        const c = {};
        this.devices.forEach(d => {
            const m = /^([A-Za-z]{1,24}?)(\d+)$/.exec(d.name || '');
            if (m) c[m[1]] = Math.max(c[m[1]] || 0, parseInt(m[2], 10));
        });
        this._nameCounts = c;
    }
}

// 启动
document.addEventListener('DOMContentLoaded', () => {
    window.topViewer = new ENSPTopoViewer();
});
