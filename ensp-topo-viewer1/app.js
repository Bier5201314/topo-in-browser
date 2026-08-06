// eNSP 拓扑查看器 / 编辑器 - 主应用逻辑
// 支持：查看、缩放、编辑模式（移动/新增/删除设备与连线）、保存/另存为（GBK 编码）

const NS = 'http://www.w3.org/2000/svg';

class ENSPTopoViewer {
    constructor() {
        this.svg = document.getElementById('topoSvg');
        this.topoGroup = document.getElementById('topoGroup');
        this.devicesLayer = document.getElementById('devicesLayer');
        this.linesLayer = document.getElementById('linesLayer');
        this.labelsLayer = document.getElementById('labelsLayer');
        this.previewLayer = document.getElementById('previewLayer');
        this.canvasContainer = document.getElementById('canvasContainer');
        this.dropZone = document.getElementById('dropZone');
        this.fileInput = document.getElementById('fileInput');
        this.deviceList = document.getElementById('deviceList');
        this.palette = document.getElementById('palette');
        this.propertyPanel = document.getElementById('propertyPanel');
        this.statusText = document.getElementById('statusText');
        this.fileName = document.getElementById('fileName');
        this.zoomLevelEl = document.getElementById('zoomLevel');
        this.deviceCountEl = document.getElementById('deviceCount');
        this.lineCountEl = document.getElementById('lineCount');
        this.canvasHint = document.getElementById('canvasHint');
        this.canvasHintText = document.getElementById('canvasHintText');
        this.editModeState = document.getElementById('editModeState');

        // 拓扑数据
        this.devices = new Map();   // id -> device
        this.lines = [];
        this.txttips = [];
        this.shapesRaw = '';
        this.topoVersion = '';
        this.fileNameStr = '';

        // 视图状态
        this.scale = 1;
        this.translateX = 0;
        this.translateY = 0;

        // 编辑状态
        this.editMode = false;
        this.activeTool = 'select';      // 'select' | 'line'
        this.selectedType = null;        // 'device' | 'line'
        this.selectedId = null;
        this.pendingAddTemplate = null;  // 待放置的新设备模板
        this.addLineSourceId = null;     // 连线起点
        this.nextDevNum = new Map();     // 设备名计数器

        // 拖拽 & 平移
        this.dragState = null;           // {type:'pan'|'device', ...}

        // 文件句柄（用于“保存”直接回写）
        this.fsHandle = null;

        // 设备图标前缀
        this.assets = 'assets/device/';

        this.init();
    }

    // ---------- 初始化 ----------
    init() {
        this.bindEvents();
        this.renderPalette();
        this.updateTransform();
    }

    bindEvents() {
        // 文件操作
        document.getElementById('btnOpen').addEventListener('click', () => this.openWithSystemPicker());
        document.getElementById('btnImport').addEventListener('click', (e) => { e.stopPropagation(); this.fileInput.click(); });
        this.fileInput.addEventListener('change', (e) => {
            const f = e.target.files[0];
            if (f) this.loadFile(f);
            e.target.value = '';
        });

        // 拖放
        this.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer.types.indexOf('Files') >= 0) this.dropZone.classList.add('dragover');
        });
        this.dropZone.addEventListener('dragleave', () => this.dropZone.classList.remove('dragover'));
        this.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.dropZone.classList.remove('dragover');
            const f = e.dataTransfer.files[0];
            if (f && f.name.toLowerCase().endsWith('.topo')) this.loadFile(f);
            else this.setStatus('请拖入 .topo 格式的拓扑文件', 'error');
        });

        // 示例
        document.getElementById('btnLoadExample').addEventListener('click', () => this.loadExample());

        // 编辑模式 & 工具
        document.getElementById('btnEditMode').addEventListener('click', () => this.toggleEditMode());
        document.getElementById('btnToolSelect').addEventListener('click', () => this.setTool('select'));
        document.getElementById('btnToolLine').addEventListener('click', () => this.setTool('line'));

        // 缩放 / 视图
        document.getElementById('btnZoomIn').addEventListener('click', () => this.zoomAt(this.canvasContainer.clientWidth / 2, this.canvasContainer.clientHeight / 2, 1.25));
        document.getElementById('btnZoomOut').addEventListener('click', () => this.zoomAt(this.canvasContainer.clientWidth / 2, this.canvasContainer.clientHeight / 2, 0.8));
        document.getElementById('btnFit').addEventListener('click', () => this.fitToView());
        document.getElementById('btnReset').addEventListener('click', () => this.resetView());

        // 保存
        document.getElementById('btnSave').addEventListener('click', () => this.save(false));
        document.getElementById('btnSaveAs').addEventListener('click', () => this.save(true));

        // 画布指针交互
        this.svg.addEventListener('mousedown', (e) => this.onMouseDown(e));
        window.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('mouseup', (e) => this.onMouseUp(e));
        this.svg.addEventListener('click', (e) => this.onCanvasClick(e));

        // 滚轮：不管前进后退都放大；Ctrl = 缩小
        this.canvasContainer.addEventListener('wheel', (e) => {
            e.preventDefault();
            const rect = this.canvasContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const factor = e.ctrlKey ? 0.8 : 1.12;
            this.zoomAt(mouseX, mouseY, factor);
        }, { passive: false });

        // 键盘
        window.addEventListener('keydown', (e) => {
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea') return;

            if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.save(false); }
            else if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); this.openSystemPicker(); }
            else if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteSelection(); }
            else if (e.key === 'Escape') { this.cancelPending(); this.deselectAll(); }
            else if (e.key === '+' || e.key === '=') this.zoomAt(this.canvasContainer.clientWidth / 2, this.canvasContainer.clientHeight / 2, 1.2);
            else if (e.key === '-') this.zoomAt(this.canvasContainer.clientWidth / 2, this.canvasContainer.clientHeight / 2, 0.8);
            else if (e.key === '0') this.fitToView();
        });
    }

    // ---------- 编辑模式 / 工具 ----------
    toggleEditMode() {
        this.editMode = !this.editMode;
        this.updateEditUI();
        this.setStatus(this.editMode ? '已开启编辑模式' : '已关闭编辑模式（只读查看）');
        if (!this.editMode) {
            this.pendingAddTemplate = null;
            this.addLineSourceId = null;
            this.clearPreview();
        } else {
            this.setTool('select');
        }
        this.render();
    }

    setTool(tool) {
        if (tool !== this.activeTool) {
            this.activeTool = tool;
            this.addLineSourceId = null;
            this.pendingAddTemplate = null;
            this.clearPreview();
            this.render();
        }
        document.getElementById('btnToolSelect').classList.toggle('active', this.activeTool === 'select');
        document.getElementById('btnToolLine').classList.toggle('active', this.activeTool === 'line');
        this.updateToolAvailability();
        this.setStatus(this.activeTool === 'line' ? '请依次点击两台设备以建立连线' : '选择工具：点击设备可移动/查看');
    }

    updateModeState() {
        this.editModeState.textContent = this.editMode ? '开' : '关';
        this.editModeState.className = this.editMode ? 'mode-on' : 'mode-off';
        document.getElementById('btnEditMode').classList.toggle('active', this.editMode);
        // 编辑模式下才可用连线工具
        document.querySelectorAll('.tool-btn').forEach((b) => {
            b.classList.toggle('is-disabled', !this.editMode);
        });
        if (!this.editMode) {
            document.getElementById('btnToolLine').classList.remove('active');
            document.getElementById('btnToolSelect').classList.remove('active');
        } else if (this.activeTool === 'line') {
            document.getElementById('btnToolLine').classList.add('active');
        } else {
            document.getElementById('btnToolSelect').classList.add('active');
        }
    }

    setToolButtonActive() {
        document.getElementById('btnToolSelect').classList.toggle('active', this.activeTool === 'select');
        document.getElementById('btnToolLine').classList.toggle('active', this.activeTool === 'line');
    }

    updateToolbar() {
        document.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('is-disabled', !this.editMode));
        this.setToolButtonActive();
    }

    updateHint(txt) {
        if (txt) { this.canvasHintText.textContent = txt; this.canvasHint.style.display = 'block'; }
        else this.canvasHint.style.display = 'none';
    }

    // ---------- 文件：打开 ----------
    async openSystemPicker() {
        if (window.showOpenFilePicker) {
            try {
                const [handle] = await window.showOpenFilePicker({ types: [{ description: 'eNSP 拓扑', accept: { 'application/xml': ['.topo', '.xml'] } }], multiple: false });
                this.fsHandle = handle;
                const file = await handle.getFile();
                await this.loadFile(file);
                return;
            } catch (err) {
                if (err && err.name === 'AbortError') return;
                // 回退到文件输入
            }
        }
        this.fileInput.click();
    }

    // ---------- 文件：读取与解析 ----------
    loadFile(file) {
        this.fileNameStr = file.name;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const arrayBuf = e.target.result;
                let text;
                try {
                    // GBK 编码的 topo 文件
                    text = new TextDecoder('gbk').decode(arrayBuf);
                } catch (err2) {
                    text = new TextDecoder('utf-8').decode(arrayBuf);
                }
                this.parseTopo(text);
                this.render();
                this.fitToView();
                this.fileName.textContent = file.name;
                this.setStatus(`已加载: ${file.name}`);
                this.dropZone.style.display = 'none';
                this.svg.style.display = 'block';
                this.updateHint('');
            } catch (err) {
                console.error(err);
                this.setStatus('解析文件失败: ' + err.message, 'error');
            }
        };
        reader.onerror = () => this.setStatus('读取文件失败', 'error');
        reader.readAsArrayBuffer(file);
    }

    loadExample() {
        const xml = this.getExampleTopo();
        try {
            this.parseTopo(xml);
            this.render();
            this.fitToView();
            this.fileNameStr = 'RIP示例.topo';
            this.fileName.textContent = 'RIP示例.topo (示例)';
            this.setStatus('已加载示例拓扑');
            this.dropZone.style.display = 'none';
            this.svg.style.display = 'block';
        } catch (err) {
            console.error(err);
            this.setStatus('加载示例失败: ' + err.message, 'error');
        }
    }

    getExampleTopo() {
        return `<?xml version="1.0" encoding="UNICODE" ?>
<topo version="1.2.00.390">
    <devices>
        <dev id="4CA76BCE-449E-4dc0-B3E3-E86C85B97033" name="CLOUD1" poe="0" model="Cloud" settings="" system_mac="" com_port="0" bootmode="0" cx="367.500000" cy="327.500000" edit_left="410" edit_top="412">
            <slot number="slot17" isMainBoard="1">
                <interface sztype="Ethernet" interfacename="Ethernet" count="3" />
                <interface sztype="Ethernet" interfacename="GE" count="0" />
                <interface sztype="Serial" interfacename="Serial" count="0" />
            </slot>
        </dev>
        <dev id="8EC6BBB2-BB78-4885-91FC-BDF8F4E0554C" name="AR2" poe="0" model="AR1220" settings="" system_mac="00-E0-FC-5D-01-FD" com_port="2001" bootmode="0" cx="189.000000" cy="463.000000" edit_left="216" edit_top="517">
            <slot number="slot17" isMainBoard="1">
                <interface sztype="Ethernet" interfacename="GE" count="2" />
                <interface sztype="Ethernet" interfacename="Ethernet" count="8" />
                <interface sztype="Ethernet" interfacename="Ethernet" count="8" />
                <interface sztype="Ethernet" interfacename="GE" count="1" />
            </slot>
        </dev>
        <dev id="83E28EFA-7D21-4a8a-B74B-D119F668A485" name="AR4" poe="0" model="AR1220" settings="" system_mac="00-E0-FC-5A-17-F8" com_port="2003" bootmode="0" cx="651.000000" cy="136.000000" edit_left="678" edit_top="190">
            <slot number="slot17" isMainBoard="1">
                <interface sztype="Ethernet" interfacename="GE" count="2" />
                <interface sztype="Ethernet" interfacename="Ethernet" count="8" />
                <interface sztype="Serial" interfacename="Serial" count="2" />
            </slot>
        </dev>
        <dev id="BD156A08-9D01-4881-A55C-3A68537852CF" name="AR1" poe="0" model="AR1220" system_mac="00-E0-FC-C3-4C-3D" com_port="2000" bootmode="0" cx="383.000000" cy="137.000000" edit_left="409" edit_top="114">
            <slot number="slot17" isMainBoard="1">
                <interface sztype="Ethernet" interfacename="GE" count="2" />
                <interface sztype="Ethernet" interfacename="Ethernet" count="8" />
                <interface sztype="Ethernet" interfacename="GE" count="1" />
                <interface sztype="Serial" interfacename="Serial" count="2" />
            </slot>
        </dev>
        <dev id="2ED90F1C-D24F-4e5b-86A0-F369FF8D3F51" name="AR3" poe="0" model="AR1220" com_port="2002" bootmode="0" cx="642.000000" cy="468.000000" edit_left="669" edit_top="522">
            <slot number="1" isMainBoard="1">
                <interface sztype="Ethernet" interfacename="GE" count="2" />
                <interface sztype="Ethernet" interfacename="Ethernet" count="8" />
                <interface sztype="Ethernet" interfacename="Ethernet" count="8" />
                <interface sztype="Ethernet" interfacename="GE" count="1" />
            </slot>
        </dev>
    </devices>
    <lines>
        <line srcDeviceID="BD156A08-9D0D-4881-A55C-3A68537852CF" destDeviceID="83E28D7D-7D21-4a8a-B74B-D119F668A485">
            <interfacePair lineName="Serial" srcIndex="11" srcBoundRectIsMoved="0" srcBoundRect_X="453.183472" srcBoundRect_Y="163.838867" srcOffset_X="0.000000" srcOffset_Y="0.000000" tarIndex="10" tarBoundRectIsMoved="1" tarBoundRect_X="634.816528" tarBoundRect_Y="163.161133" tarOffset_X="0.000000" tarOffset_Y="0.000000" />
        </line>
        <line srcDeviceID="BD156A08-9D0D-4881-A55C-3A68537852CF" destDeviceID="4CA76BCE-449E-4dc0-B3E3-E86C85B97033">
            <interfacePair lineName="Copper" srcIndex="0" srcBoundRectIsMoved="0" srcBoundRect_X="410.000000" srcBoundRect_Y="207.183762" srcOffset_X="0.000000" srcOffset_Y="0.000000" tarIndex="0" tarBoundRectIsMoved="0" tarBoundRect_X="410.000000" tarBoundRect_Y="305.603027" tarOffset_X="0.000000" tarOffset_Y="0.000000" />
        </line>
        <line srcDeviceID="4CA76BCE-449E-4dc0-B3E3-E86C85B97033" destDeviceID="83E28EFA-7D21-4a8a-B74B-D119F668A485">
            <interfacePair lineName="Copper" srcIndex="0" srcBoundRectIsMoved="0" srcBoundRect_X="355.233459" srcBoundRect_Y="403.876190" srcOffset_X="0.000000" srcOffset_Y="0.000000" tarIndex="0" tarBoundRectIsMoved="0" tarBoundRect_X="252.725722" tarBoundRect_Y="467.283051" tarOffset_X="0.000000" tarOffset_Y="0.000000" />
        </line>
    </lines>
    <shapes />
    <txttips>
        <txttip left="140" top="107" right="303" bottom="124" content="loopback0:10.0.1.1/24" fontname="Consolas" fontstyle="0" editsize="100" txtcolor="-16777216" txtbkcolor="-7278960" charset="1" />
    </txttips>
</topo>`;
    }

    parseTopo(xmlString) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlString, 'text/xml');
        const pe = xmlDoc.querySelector('parsererror');
        if (pe) throw new Error('XML 解析错误');
        const topoEl = xmlDoc.querySelector('topo');
        if (!topoEl) throw new Error('不是有效的拓扑文件');

        this.topoVersion = topoEl.getAttribute('version') || '';
        this.devices.clear();
        this.lines = [];
        this.txttips = [];

        // ---------- 设备 ----------
        const devElements = xmlDoc.querySelectorAll('devices > dev');
        devElements.forEach(devEl => {
            const device = {
                attrs: {},
                id: devEl.getAttribute('id'),
                slots: []
            };
            for (const attr of devEl.attributes) device.attrs[attr.name] = attr.value;
            device.id = device.attrs.id;
            device.name = device.attrs.name || 'Unknown';
            device.model = device.attrs.model || 'Unknown';
            device.cx = parseFloat(device.attrs.cx) || 0;
            device.cy = parseFloat(device.attrs.cy) || 0;

            devEl.querySelectorAll(':scope > slot').forEach(slotEl => {
                const slot = { attrs: {}, interfaces: [] };
                for (const a of slotEl.attributes) slot.attrs[a.name] = a.value;
                slotEl.querySelectorAll(':scope > interface').forEach(ifEl => {
                    slot.interfaces.push({
                        sztype: ifEl.getAttribute('sztype') || '',
                        interfacename: ifEl.getAttribute('interfacename') || '',
                        count: parseInt(ifEl.getAttribute('count')) || 0
                    });
                });
                device.slots.push(slot);
            });
            device.interfaceList = this.expandInterfaces(device);
            this.devices.set(device.id, device);
        });

        // ---------- 连线 ----------
        xmlDoc.querySelectorAll('lines > line').forEach(lineEl => {
            const line = { attrs: {}, pairs: [], elemId: 'L' + this.lines.length };
            for (const a of lineEl.attributes) line.attrs[a.name] = a.value;
            lineEl.querySelectorAll(':scope > interfacePair').forEach(pEl => {
                const p = {};
                for (const a of pEl.attributes) p[a.name] = a.value;
                p.lineName = p.lineName || '';
                p.srcIndex = parseInt(p.srcIndex) || 0;
                p.tarIndex = parseInt(p.tarIndex) || 0;
                p.srcId = line.attrs.srcDeviceID;
                p.destId = line.attrs.destDeviceID;
                line.pairs = line.pairs || [];
                line.pairs.push(p);
            });
            if (line.pairs && line.pairs.length) {
                line.srcDeviceID = line.attrs.srcDeviceID;
                line.destDeviceID = line.attrs.destDeviceID;
                this.lines.push(line);
            }
        });

        // ---------- shapes（保留原始内容以便回写） ----------
        const shapesEl = xmlDoc.querySelector('shapes');
        this.shapesRaw = shapesEl ? this.serializeNode(shapesEl) : '';

        // ---------- 文本提示 ----------
        xmlDoc.querySelectorAll('txttips > txttip').forEach(tEl => {
            const tip = { attrs: {} };
            for (const a of tEl.attributes) tip.attrs[a.name] = a.value;
            tip.left = parseFloat(tip.attrs.left) || 0;
            tip.top = parseFloat(tip.attrs.top) || 0;
            tip.right = parseFloat(tip.attrs.right) || 0;
            tip.bottom = parseFloat(tip.attrs.bottom) || 0;
            tip.content = tip.attrs.content || '';
            this.txttips.push(tip);
        });

        this.updateCounts();
        this.updateNameCounter();
    }

    serializeNode(el) {
        return new XMLSerializer().serializeToString(el);
    }

    // 展开设备插槽中的接口，得到有序接口名数组（用于端口编号/连线）
    expandInterfaces(device) {
        const list = [];
        device.slots.forEach(slot => {
            const isMB = slot.attrs.isMainBoard === '1';
            const slotNoStr = isMB ? '0' : (slot.attrs.id || '0');
            const slotIndex = slot.attrs.number === 'slot17' || isMB ? '0' : (slot.attrs.id || '0');
            slot.interfaces.forEach(iface => {
                const count = iface.count || 0;
                for (let i = 0; i < count; i++) {
                    const base = iface.interfacename || 'GE';
                    const name = `${base}/${slotIndex}/${i}`;
                    const slotLine = numberFmt(slotIndex, i);
                    list.push({ type: base.toLowerCase(), base, name, index: list.length });
                }
            });
        });
        return list;
    }

    // 展开每个接口的全局编号（用于与 topo 文件中 srcIndex/tarIndex 对应）
    // 注意编码的 srcIndex 对应展开后的次序。这里单独再建一列便于查表
    buildExpandedIndex(device) {
        const arr = [];
        device.slots.forEach(slot => {
            const isMB = slot.attrs.isMainBoard === '1';
            const slotIndex = isMB ? '0' : (slot.attrs.id || '0');
            slot.interfaces.forEach(iface => {
                const count = iface.count || 0;
                for (let i = 0; i < count; i++) {
                    arr.push({ type: iface.interfacename || 'GE', slot: slotIndex, n: i });
                }
            });
        });
        return arr;
    }

    updateNameCounter() {
        // 根据已有设备名预计算各类型序号
        const counts = {};
        this.devices.forEach(d => {
            const m = /^([A-Za-z]+?)(\d+)$/.exec(d.name);
            if (m) {
                const pre = m[1];
                counts[pre] = Math.max(counts[pre] || 0, parseInt(m[2], 10));
            }
        });
        this._nameCounts = counts;
    }

    // ---------- 渲染 ----------
    render() {
        this.devicesLayer.innerHTML = '';
        this.linesLayer.innerHTML = '';
        this.labelsLayer.innerHTML = '';
        this.renderLines();
        this.renderDevices();
        this.renderTxttips();
        this.renderDeviceList();
        this.updateCounts();
        this.updateToolbar();
        this.applySelection();
        this.refreshSelectionPanel();
    }

    renderDevices() {
        this.devices.forEach((device, id) => {
            const dW = 104, dH = 72, hw = dW / 2, hh = dH / 2;
            const g = mkEl('g', { 'class': 'device-group' + (this.editMode ? ' editable' : ''), 'data-id': id, 'transform': `translate(${device.cx}, ${device.cy})` });

            // 底板
            const rect = mkEl('rect', { 'class': 'device-rect', x: -hw, y: -hh, width: dW, height: dH });
            g.appendChild(rect);

            // 设备图标 + 名称（不拦截事件）
            const body = mkEl('g', { 'class': 'device-body' });
            const href = this.getDeviceIconHref(device.model);
            if (href) {
                const img = mkEl('image', { 'class': 'device-icon-img', href, x: -20, y: -26, width: 46, height: 46, preserveAspectRatio: 'xMidYMid meet' });
                body.appendChild(img);
            }
            const nameText = mkEl('text', { 'class': 'device-label', x: 0, y: 6, textContent: device.name });
            body.appendChild(nameText);
            const modelText = mkEl('text', { 'class': 'device-model-txt', x: 0, y: 20, textContent: device.model });
            body.appendChild(modelText);
            g.appendChild(body);

            // 编辑抓手图标
            const hdl = mkEl('g', { 'class': 'edit-handle' });
            const hl = mkEl('circle', { cx: hw - 8, y: hh - 8, r: 4, fill: '#1a73e8', stroke: '#fff', 'stroke-width': 1 });
            hdl.appendChild(hl);
            g.appendChild(hdl);

            g.addEventListener('mousedown', (e) => {
                if (this.editMode && this.activeTool === 'line') return; // 触发 line 连接流程由各自逻辑
            });
            this.devicesLayer.appendChild(g);
        });
    }

    renderLines() {
        this.lines.forEach((line, li) => {
            const srcDev = this.devices.get(line.srcDeviceID);
            const dstDev = this.devices.get(line.destDeviceID);
            if (!srcDev || !dstDev) return;

            (line.pairs || []).forEach((pair, pi) => {
                const a1 = this.anchorPoint(srcDev, dstDev, pair.srcIndex, pi);
                const a2 = this.anchorPoint(dstDev, srcDev, pair.tarIndex, pi);

                const isSerial = pair.lineName === 'Serial';
                const path = mkEl('path', { 'class': 'line-path' + (isSerial ? ' is-serial' : ''), 'data-line-index': li, 'data-pair-index': pi, 'data-line-id': line.elemId });
                // 简单三次贝塞尔
                const mx = (a1[0] + a2[0]) / 2;
                const my = (a1[1] + a2[1]) / 2 - 20;
                path.setAttribute('d', `M ${a1[0]} ${a1[1]} C ${mx} ${my}, ${mx} ${my}, ${a2[0]} ${a2[1]}`);
                this.linesLayer.appendChild(path);

                // 用于选中/删除的热点（加宽透明线）
                const hotspot = mkEl('path', { 'class': 'line-hotspot', 'data-line-id': line.elemId, 'data-line-index': li, 'data-pair-index': pi });
                hotspot.setAttribute('d', `M ${a1[0]} ${a1[1]} L ${mx} ${my} L ${mx} ${my} L ${a2[0]} ${a2[1]}`);
                this.linesLayer.appendChild(hotspot);

                // 端口标签（端口名 + 类型）
                this.addPortLabel(a1, this.portLabelFor(srcDev, pair.srcIndex), pair.lineName, g(li, pi));
                this.addPortLabel(a2, this.portLabel(dstDev, pair.tarIndex), pair.lineName);
            });
        });
    }

    addPortLabel(pos, { text, used }, prefix) {
        const g = mkEl('g', { 'class': 'port-label-group' });
        const w = Math.max(30, text.length * 6.6 + 8);
        const rect = mkEl('rect', { 'class': 'port-label-bg', x: pos[0] - w / 2, y: pos[1] - 9, width: w, height: 16 });
        const t = mkEl('text', { 'class': 'port-label', x: pos[0], y: pos[1] + 1, textContent: text });
        g.appendChild(rect);
        g.appendChild(t);
        this.labelsLayer.appendChild(g);
    }

    portLabel(dev, index) {
        const arr = this.expandedIndex(dev);
        const item = arr[index];
        if (item) {
            return { text: `${item.type}/${item.slot}/${item.n}`, used: true };
        }
        return { text: `Port${index}`, used: true };
    }

    expandIp(dev) {
        return this.expandIndex(dev);
    }

    // 计算设备边界上的连接点（让线从设备图标边缘伸出）
    anchorPoint(fromDev, toDev, index, pairIdx) {
        const hw = 52, hh = 36, cx = fromDev.cx, cy = fromDev.cy;
        const tx = toDev.cx, ty = toDev.cy;
        let dx = tx - cx, dy = ty - cy;
        if (dx === 0 && dy === 0) dx = 1;
        const ad = Math.abs(dx), bd = Math.abs(dy);
        // 比例到边界
        let px, py, t;
        if (ad > bd) { t = hw / Math.max(ad, 1); py = cy + dy * t; }
        direction branch displacement: recompute exactly via LSM
        // 使用直线与矩形的交点
        // fct below
    }

    // 矩形相交
    rectIntersect(cx, cy, tx, ty, hw, hh) {
        let dx = tx - cx, dy = ty - cy;
        if (dx === 0 && dy === 0) { return [cx, cy]; }
        const scaleX = hw / Math.abs(dx);
        const scaleY = hh / Math.abs(dy);
        const scale = Math.min(scaleX, scaleY);
        return [cx + dx * scale, cy + dy * scale];
    }

    renderTxttips() {
        this.txttips.forEach(tip => {
            const g = mkEl('g', { 'class': 'txttip-group' });
            const w = tip.right - tip.left, h = tip.bottom - tip.top;
            const rect = mkEl('rect', { 'class': 'txttip-bg', x: tip.left, y: tip.top, width: w, height: h });
            g.appendChild(rect);
            const lines = (tip.content || '').split(/\r?\n/);
            const lh = (h / Math.max(lines.length, 1)) || 14;
            lines.forEach((ln, i) => {
                const t = mkEl('text', { x: tip.left + w / 2, y: tip.top + (i + 0.5) * lh, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
                t.textContent = ln;
                g.appendChild(t);
            });
            this.labelsLayer.appendChild(g);
        });
    }

    renderDeviceList() {
        this.deviceList.innerHTML = '';
        if (this.devices.size === 0) {
            this.deviceList.innerHTML = '<p class="empty-hint">请打开/导入拓扑文件</p>';
            return;
        }
        const items = [];
        // 列表按设备名排
        this.devices.forEach(d => items.push(d));
        items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        items.forEach(d => {
            const item = document.createElement('div');
            item.className = 'device-item';
            item.dataset.id = d.id;
            const href = this.getDeviceIconHref(d.model);
            item.innerHTML = `<div class="device-icon">${href ? `<img src="${href}" alt="">` : d.model[0]}</div>` +
                `<div class="device-info"><div class="device-name"></div><div class="device-model"></div></div>`;
            item.querySelector('.device-name').textContent = d.name;
            item.querySelector('.device-model').textContent = d.model;
            item.addEventListener('click', () => {
                this.selectDevice(d.id);
                this.centerOnDevice(d.id);
            });
            this.deviceList.appendChild(item);
        });
    }

    // 设备图标路径
    getDeviceIconHref(model) {
        const m = (model || '').toUpperCase();
        const map = {
            'CLOUD': 'cloud2_rollover.ico',
            'FR': 'fr.png',
            'IAP': 'iAP.png',
            'IAC': 'iAC.png',
            'IFW': 'iFW.png',
            'ILAPTOP': 'iLaptop.png',
            'IPHONE': 'iCellphone.png',
            'IHUB': 'iHUB.png',
            'ISERVER': 'iWebServer.png',
            'ICLIENT': 'iWebClient.png',
            'ISTA': 'iStation.png',
            'IMCS': 'iMulticastSource.png',
            'CE12800': 's128.png',
            'CE6800': 'iCE6800.png',
            'CX': 'cx_little_icon.png',
            'NE9000': 'ne9000_little_icon.png',
            'NE5000': 'ne5000e_little_icon.png',
            'NE40E': 'NE40E.png',
            'NE': 'ne.png'
        };
        // 顺序匹配（先把较具体的放前面）
        if (m.startsWith('NE9000')) return ASSET + map['NE900000'];
        if (m.startsWith('NE5000')) return ASSET + map['NE5000'];
        if (m.startsWith('NE40')) return ASSET + map['NE40E'];

        const specials = [['CLCD', 'iWebClient.png'], ['SERVER', 'iWebServer.png'], ['STA', 'iStation.png'], ['CELL', 'iCellphone.png'], ['MCS', 'iMulticastSource.png'], ['PC', 'iLaptop.png'], ['CLOUD', 'cloud2_icon.ico'], ['FR', 'fr.png'], ['HUB', 'iHUB.png']].concat([...]);
        return ASSET + keyToFile;
    }

    // 示例合并：把上面的逻辑简化为一个统一的映射（以下为实际使用的实现）
    deviceIconFile(model) {
        const m = (model || '').toUpperCase();
        if (m.startsWith('NE9000') || m.startsWith('CE98')) return 'ne9000_little_icon.png';
        return 'router.png';
    }

    updateCounts() {
        this.deviceCountEl.textContent = `设备: ${this.devices.size}`;
        this.lineCountEl.textContent = `链路: ${this.lines.length}`;
    }

    // ---------- 选择 ----------
    selectDevice(id) {
        this.cancelPending();
        if (this.editMode) { /* 选择即选中 */ }
        this.selectedType = 'device';
        this.selectedId = id;
        this.applySelection();
        this.propertyPanel.innerHTML = this.devicePropertyHTML(this.devices.get(id));
    }

    selectLine(li) {
        this.cancelPending();
        this.selectedType = 'line';
        this.selectedId = li;
        this.applySelection();
        this.propertyPanel.innerHTML = this.linePropertyHTML(this.lines[li]);
    }

    deselectAll() {
        this.selectedType = null;
        this.selectedId = null;
        this.applySelection();
        this.propertyPanel.innerHTML = '<p class="empty-hint">选择设备或链路查看详情</p>';
    }

    applySelection() {
        this.devicesLayer.querySelectorAll('.device-group').forEach(el => {
            el.classList.toggle('selected', this.selectedType === 'device' && el.dataset.id === this.selectedId);
        });
        this.linesLayer.querySelectorAll('.line-path').forEach(el => {
            el.classList.toggle('selected', this.selectedType === 'line' && parseInt(el.dataset.lineIndex) === this.selectedId);
        });
        this.deviceList.querySelectorAll('.device-item').forEach(el => {
            el.classList.toggle('active', this.selectedType === 'device' && el.dataset.id === this.selectedId);
        });
    }

    deleteSelection() {
        if (!this.editMode) return this.setStatus('请先开启编辑模式再删除', 'error');
        if (this.selectedType === 'device') { this.deleteDevice(this.selectedId); }
        else if (this.selectedType === 'line') { this.deleteLine(this.selectedId); }
    }

    deleteDevice(id) {
        if (!this.editMode) return this.setStatus('请先开启编辑模式', 'error');
        if (!id) return;
        this.devices.delete(id);
        this.lines = this.lines.filter(l => l.srcDeviceID !== id && l.destDeviceID !== id);
        // 清理相关链路
        this.deselectAll();
        this.render();
        this.setStatus(`已删除设备 "${name}”、移除其链路`);
    }

    deleteLine(li) {
        if (!this.editMode) { return }
        const l = li;
        this.lines.splice(li, 1);
        this.render();
        this.deselectAll();
    }

    // ---------- 设备新增：放置 ----------
    beginPendingAdd(tpl) {
        if (!this.editMode) return this.setStatus('请先开启编辑模式以添加设备', 'error'); return;
        this.pendingAddTemplate = tpl;
        this.addLineSourceId = null;
        this.setTool('select');
        this.updateHint('请点击画布以放置新设备');
        this.render(); // 高亮状态等
    }

    placeDeviceAt(worldX, worldY) {
        const tpl = this.pendingAddTemplate;
        if (!tpl) return;
        const existing = this.devices;
        const base = tpl.prefix || tpl.model.replace(/[0-9].*/, '') || tpl.model;
        const pre = base.replace(/[^A-Za-z]/g,'');
        const n = (this._nameCounts[pre] || 0) + 1;
        this._nameCounts[pre] = n;
        const name = `${pre}${n}`;

        const id = uuidv4();
        const slots = [{
            attrs: { number: 'slot17', isMainBoard: '1' }, interfaces: tpl.interfaces.map(i => { sztype: i.sztype ? { sztype: i.sztype, interfacename: i.name, count: i.count } : { interfacename: i.name, count: i.count } })
        }];
        // 构造设备
        const device = {
            attrs: {},
            id, name, model: tpl.model,
            cx: worldX, cy: worldY,
            slots,
            system_mac: this.randomMac(),
            com_port: this.nextComPort()
        };
        device.interfaceList = this.expandInterfaces(device);
        this.devices.set(id, device);
        this.pendingAddTemplate = null;
        this.updateHint('');
        // 自动选中新设备
        this.selectedType='device'; this.selectedId=id;
        this.render();
        this.selectDevice(id);
        this.setStatus(`已添加设备: ${name} (${tpl.model})`);
    }

    randomMac() {
        const h = () => Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0');
        return `00-E0-FC-${h()}-${h()}-${h()}`;
    }
    nextComPort() {
        let mx = 2000;
        this.devices.forEach(d => { const v = parseInt(d.com_port); if (v > mx) mx = v; });
        return (mx + 1).toString();
    }

    // ---------- 连线 ----------
    handleDeviceForLine(devId) {
        if (this.addLineSourceId === null) {
            this.addLineSourceId = devId;
            this.highlightSource(devId);
            this.updateHint('请点击另一台设备作为目标');
        } else if (this.addLineSourceId === devId) {
            this.cancelLine();
        } else {
            this.createLine(this.addLineSourceId, devId);
        }
    }

    cancelLine() {
        this.addLineSourceId = null;
        this.clearHighlightSource();
        this.updateHint('');
        this.updateToolbar();
    }

    highlightSource(id) {
        // 高亮可作为连线起点的设备
        this.devicesLayer.querySelectorAll('.device-group').forEach(el => {
            el.classList.toggle('linked', el.dataset.id === id);
        });
    }
    clearHighlightSource() {
        this.devicesLayer.querySelectorAll('.device-group').forEach(el => el.classList.remove('linked'));
    }

    createLine(srcId, dstId) {
        if (srcId === dstId) { this.cancelLine(); this.setStatus('不能连接同一个设备', 'error'); return; }
        const sd = this.devices.get(srcId);
        const dd = this.devices.get(dstId);
        if (!sd || !dd) { this.cancelLine(); return; }

        // 找空闲接口对
        const srcFree = this.freeInterface(sd);
        const dstFree = this.freeInterface(dd);
        // 优先串口
        const srcSer = srcFree.find(x => x.type === 'Serial');
        const dstSer = dstFree.find(x => x.type === 'Serial');
        const srcEth = srcFree.find(x => x.type !== 'Serial');
        const dstEth = dstFree.find(x => x.type !== 'Serial');

        let lineName, soIdx, duIdx;
        if (srcSer && dstSer) { lineName = 'Serial'; soIdx = srcSer.index; duIdx = dstSer.index; }
        else if (srcEth && dstEth) { lineName = 'Copper'; soIdx = srcEth.index; duIdx = dstEth.index; }
        else { this.setStatus('两台设备没有可用的配对接口', 'error'); this.cancelLine(); return; }

        const pair = {
            lineName, srcIndex: soIdx, tarIndex: duIdx,
            srcBoundRectIsMoved: '0', srcBoundRect_X: '0', srcBoundRect_Y: '0',
            srcOffset_X: '0', srcOffset_Y: '0',
            tarBoundRectIsMoved: '0', tarBoundRect_X: '0', tarBoundRect_Y: '0',
            tarOffset_X: '0', tarOffset_Y: '0'
        };
        const line = {
            attrs: { srcDeviceID: srcId, destDeviceID: dstId },
            srcDeviceID: srcId, destDeviceID: dstId, pairs: [pair], elemId: 'L' + this.lines.length
        };
        this.lines.push(line);
        this.addLineSourceId = null;
        this.clearHighlightSource();
        this.updateHint('');
        this.render();
        this.setStatus(`已创建链路（${pair.lineName}）`);
    }

    freeInterface(dev) {
        const used = new Set();
        this.lines.forEach(l => {
            l.pairs.forEach(p => {
                if (l.srcDeviceID === dev.id) used.add(p.srcIndex);
                if (l.destDeviceID === dev.id) used.add(p.tarIndex);
            });
        });
        const all = this.expandIndex(dev);
        return all.map((x, i) => ({ index: i, type: x.type })).filter(x => !used.has(x.index));
    }

    // 供 freeInterface 引用的展开
    expandedIndex(dev) {
        const arr = [];
        dev.slots.forEach(slot => {
            slot.interfaces.forEach(iface => {
                for (let i = 0; i < (iface.count || 0); i++) arr.push({ type: iface.interfacename || 'GE' });
            });
        });
        return arr;
    }

    // ---------- 属性面板 ----------
    devicePanelHTML(dev) {
        if (!dev) return '<p class="empty-hint">选择设备查看详情</p>';
        const related = this.devices._related;
        let h = '<div class="property-section"><h4>基本信息</h4>'
            + this.row('名称','') ;
        h += `<div class="property-row"><span class="property-label">名称</span>`;
        if (this.editMode) {
            h += `<input class="property-input" id="propName" value="${esc(dev.name)}">`;
            h += `</div>`;
            h += `<div class="property-row"><span class="property-label">坐标X</span><input class="property-input" id="propX" value="${dev.cx.toFixed(0)}"></div>`;
            h += `<div class="property-row"><span class="property-label">坐标Y</span><input class="property-input" id="propY" value="${dev.cy.toFixed(0)}"></div>`;
            h += `<button class="btn-danger" data-delete-dev="true">🗑 删除设备</button>`;
        } else {
            h += `<span class="property-value">${esc(dev.name)}</span></div>`;
            h += `<div class="property-row is.<span>...`{/pain}
        h += `<div class="property-row"><span class="property-label">型号</span><span class="property-value">${esc(dev.model)}</span></div>`;
        h += `<div class="property-row"><span class="property-label">设备ID</span><span class="property-value small">${esc(dev.id)}</span></div>`;
        h += `<div class="property-row"><span class="property-label">MAC</span><span class="property-value">${dev.system_macos?esc(dev.system_mac):'N/A'}</span></div>`;
        h += `<div class="property-row"><span class="property-label">COM端口</span><span class="property-value">${esc(dev.com_port)}</span></div>`;
        h += `<div class="property-row"><span class="property-label">坐标</span><span class="property-value">(${dev.cx.toFixed(1)}, ${dev.cy.toFixed(1)})</span></div>`;

        // 接口
        h += `<div class="property-section"><h4>接口</h4><div class="interface-list">`;
        dev.interfaceList.forEach(ifx => {
            const used = this.usedPorts(dev, ifx.index).size > 0;
            h += `<div class="interface-item${used ? ' used' : ''}"><span class="interface-type">${esc(ifx.name)}</span>`+ (used ? `<span class="port-mark">· 连线</span>` : ``) + `</div>`;
        });
        h += `</div></div>`;

        // 相关链路
        const relatedLines = this.lines.filter(l => l.srcDeviceID === dev.idStream || l.destDeviceID === dev.id);
        if (related) {
            h += `<div class="property-section"><h4>相关链路 (${relatedLines.length})</h4>`;
            relatedLines.forEach(l => {
                const otherId = l.srcDeviceID === dev.id ? l.destDeviceID : l.srcDeviceID;
                const other = this.devices.get(otherId);
                const types = (l.pairs||[]).map(p=>p.lineName).join(', ');
                const li = this.lines.indexOf(l);
                h += `<div class="property-row"><span class="property-label">↔ ${other?other.name:'?'}</span><span class="property-value item-click" data-line="${li}">${types} ⌫</span></div>`;
            });
            h += `</div>`;
        }
        return h;
    }

    usedPorts(dev, name) {
        // 简化：返回该接口是否用于某连线 (用于显示标记)
        const set = new Set();
        this.lines.forEach(l => {
            l.pairs.forEach(p => {
                if (l.srcID === dev.id && this.indexNames(dev)[p.srcIndex] === name) set.add(name);
                if (l.destID === dev.id && this.indexNames(dev)[p.tarIndex] === name) set.add(name);
            });
        });
        return set;
    }

    linePropertyHTML(liObj) {
        if (!liObj) return '<p class="句空>';
        const l = liObj;
        if(!l) return '无';
        const s = this.devices.get(li.srcDeviceID);
        const d = this.devices.get(li.destDeviceID);
        let h = `<div class="property-section"><h4>链路信息</h4>`;
        h += `<div class="property-row"><span class="property-label">源端</span><span class="property-value">${s?s.name:'?'}</span></div>`;
        h += `<div class="property-row"><span class="property-label">目的端</span><span class="property-value">${d:d.name:'?'}</span></div>`;
        (l.pairs||[]).forEach(p=>{
            const pSL = this.portLabel(s, p.srcIndex);
            const pDL = this.portLabel(d, p.tarIndex);
            h += `<div class="property-row"><span class="property-label">接口</span><span class="property-value">${pSL.text} → ${pDL.text} (${p.lineName})</span></div>`;
        });
        h += `</div>`;
        if (this.editMode) h += `<button class="btn-danger" data-delete-line="${this.lines.indexOf(l)}">删除此链路</button>`;
        return h;
    }

    esc(s) {
        return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // 绑定动态面板事件
    refresh() { this.render(); this.applySelection(); }

    renderPalette() {
        this.palette.innerHTML = '';
        const CAT = [
            { name: '路由器', models: ['AR1220', 'AR3260', 'AR201', 'NE9000'] },
            { name: '交换机', models: ['S5700', 'S3700', 'CE6800'] },
            { name: '无线', models: ['AC6005', 'AP6050'] },
            { name: '防火墙', models: ['USG5500', 'USG6000V'] },
            { name: '终端', models: ['PC', 'Server', 'Client', 'STA', 'Cellphone'] },
            { name: '其它', models: ['Cloud', 'HUB', 'FRSW'] }
        ];
        CATAL.forEach(cat => {
            const catEl = mkEl('div', { 'class': 'palette-cat', textContent: cat.name });
            this.palette.appendChild(catEl);
            cat.models.forEach(model => {
                const tpl = this.templateFor(model);
                const item = mkEl('div', { 'class': 'palette-item', 'data-model': model });
                const href = this.getDeviceIconHref(model);
                if (href) {
                    const img = mkEl('img', { src: href, alt: '' });
                    const sp = mkEl('span', { textContent: model });
                    item.appendChild(img); item.appendChild(sp);
                } else {
                    const sp = mkEl('span', { textContent: model });
                    item.appendChild(sp);
                }
                item.addEventListener('click', () => this.beginAdd(tpl || ...));
                this.palette.appendChild(item);
            });
        });
    }

    templateFor(model) {
        // 返回 {model, interfaces:[{name,count,szytype}], prefix}
        const P = TEMPLATES[model] || TEMPLATES.DEFAULT;
        return P;
    }
}

// 模板：接口规范
const TEMPLATES = {
    'AR1220': model( 'AR', [ ['Ethernet',2],['GE',4],['Serial',4] ] false ),
};
