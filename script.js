import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// ==========================================
// 1. MonitorFactory: Creates monitor meshes
// ==========================================
class MonitorFactory {
    static createMonitor(config) {
        let { id, name, inches, ratioW, ratioH, curvature, isPortrait, locked } = config;

        inches = Math.max(1, parseFloat(inches) || 27);
        ratioW = Math.max(0.1, parseFloat(ratioW) || 16);
        ratioH = Math.max(0.1, parseFloat(ratioH) || 9);

        const diagonalMm = inches * 25.4;
        const ratio = ratioW / ratioH;
        const heightMm = Math.sqrt((diagonalMm * diagonalMm) / (ratio * ratio + 1));
        const widthMm = heightMm * ratio;

        const radius = parseFloat(curvature);
        
        let isValidCurvature = false;
        if (radius > 0 && radius < 10000) {
            const perimeter = 2 * Math.PI * radius;
            if (widthMm < perimeter * 0.95) {
                isValidCurvature = true;
            }
        }

        // 텍스처 최적화: 기존 텍스처가 있으면 재사용, 없으면 새로 생성
        const texture = this.createScreenTexture(name, inches, ratioW, ratioH);
        
        // [최적화] Standard(PBR) -> Lambert(Gouraud) 재질 변경으로 연산량 대폭 감소
        const bodyMaterial = new THREE.MeshLambertMaterial({ 
            color: 0x111111 
        });
        
        const screenMaterial = new THREE.MeshLambertMaterial({
            map: texture,
            emissive: 0xffffff,
            emissiveMap: texture,
            emissiveIntensity: 0.2,
            side: THREE.DoubleSide
        });

        const group = new THREE.Group();

        if (!isValidCurvature) {
            const screenGeo = new THREE.PlaneGeometry(widthMm, heightMm);
            const screenMesh = new THREE.Mesh(screenGeo, screenMaterial);

            const bodyGeo = new THREE.BoxGeometry(widthMm, heightMm, 20);
            bodyGeo.translate(0, 0, -10.1); 
            const bodyMesh = new THREE.Mesh(bodyGeo, bodyMaterial);

            group.add(bodyMesh);
            group.add(screenMesh);

            screenMesh.frustumCulled = false;
            bodyMesh.frustumCulled = false;

        } else {
            const theta = widthMm / radius;
            const thetaStart = Math.PI - (theta / 2);
            
            // [최적화] 세그먼트 개수 감소 (64 -> 32)
            const screenGeo = new THREE.CylinderGeometry(
                radius, radius, heightMm, 
                32, 1, true, 
                thetaStart, theta
            );
            screenGeo.translate(0, 0, radius + 0.5); 
            const screenMesh = new THREE.Mesh(screenGeo, screenMaterial);
            texture.center.set(0.5, 0.5);
            texture.repeat.set(-1, 1);
            screenMesh.frustumCulled = false;

            const shape = new THREE.Shape();
            shape.absarc(0, 0, radius, -theta/2, theta/2, false);
            shape.absarc(0, 0, radius + 20, theta/2, -theta/2, true);
            
            const extrudeSettings = { 
                depth: heightMm, 
                bevelEnabled: false,
                curveSegments: 12 // [최적화] 곡선 분할 감소 (32 -> 12)
            };
            const bodyGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
            bodyGeo.translate(0, 0, -heightMm / 2);
            bodyGeo.rotateX(-Math.PI / 2); 
            bodyGeo.rotateY(Math.PI / 2); 
            bodyGeo.translate(0, 0, radius);

            const bodyMesh = new THREE.Mesh(bodyGeo, bodyMaterial);
            bodyMesh.frustumCulled = false;

            group.add(bodyMesh);
            group.add(screenMesh);
        }

        if (isPortrait) {
            group.rotation.z = -Math.PI / 2;
        }

        const distanceToBottom = (isPortrait ? widthMm : heightMm) / 2;
        
        group.userData = { 
            id: id, 
            isMonitor: true, 
            distanceToBottom: distanceToBottom,
            locked: !!locked
        };
        
        group.traverse(c => {
            c.userData.parentId = id;
            c.userData.isMonitorPart = true;
        });

        return group;
    }

    static createScreenTexture(name, inches, rW, rH) {
        const safeRW = Math.max(0.1, parseFloat(rW) || 1);
        const safeRH = Math.max(0.1, parseFloat(rH) || 1);

        const canvas = document.createElement('canvas');
        canvas.width = 1024;
        canvas.height = Math.min(8192, (1024 / safeRW) * safeRH);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#050505';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 15;
        ctx.strokeRect(0, 0, canvas.width, canvas.height);

        const cx = canvas.width / 2;
        const cy = canvas.height / 2;

        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 90px "Segoe UI", Arial, sans-serif';
        ctx.fillText(name, cx, cy - 50);

        ctx.fillStyle = '#888';
        ctx.font = '50px "Segoe UI", Arial, sans-serif';
        ctx.fillText(`${inches}" (${rW}:${rH})`, cx, cy + 60);

        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        
        return tex;
    }
}

// ==========================================
// 2. SceneManager: 3D Scene & Selection Logic
// ==========================================
class SceneManager {
    constructor(container) {
        this.container = container;
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x202020);

        this.camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 10, 50000);
        this.camera.position.set(0, 1000, 2000);

        // 렌더러 설정
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        this.renderer.setPixelRatio(1); // 고해상도 디스플레이 부하 방지 (성능 최적화)
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        
        this.renderer.domElement.style.display = 'block';
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        container.appendChild(this.renderer.domElement);

        this.setupLights();

        this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
        this.orbitControls.enableDamping = true;
        this.orbitControls.dampingFactor = 0.1;
        this.orbitControls.maxPolarAngle = Math.PI / 2;

        this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
        this.transformControls.addEventListener('dragging-changed', (event) => {
            this.orbitControls.enabled = !event.value;
        });
        this.scene.add(this.transformControls);

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.monitors = []; 
        this.deskMesh = null;

        this.renderer.domElement.addEventListener('pointerdown', e => this.onPointerDown(e), { capture: true });
        
        window.addEventListener('keydown', e => {
            const tagName = document.activeElement ? document.activeElement.tagName.toUpperCase() : '';
            if (tagName === 'INPUT' || tagName === 'TEXTAREA') return;

            if ((e.key === 'Delete' || e.key === 'Backspace') && this.transformControls.object) {
                window.removeMonitor(this.transformControls.object.userData.id);
            }
        });
        
        window.addEventListener('resize', () => this.onResize());
        
        this.animate();
    }

    setupLights() {
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const dl = new THREE.DirectionalLight(0xffffff, 1.2);
        dl.position.set(1000, 2000, 1000);
        this.scene.add(dl);
    }

    updateDesk(w, d, c) {
        if (this.deskMesh) this.scene.remove(this.deskMesh);
        const geo = new THREE.BoxGeometry(w, 30, d);
        // [최적화] Standard -> Lambert 변경
        const mat = new THREE.MeshLambertMaterial({ color: c });
        this.deskMesh = new THREE.Mesh(geo, mat);
        this.deskMesh.position.y = -15; 
        this.scene.add(this.deskMesh);
    }

    setSnap(mode, enabled, value) {
        if (mode === 'translate') {
            this.transformControls.translationSnap = enabled ? parseFloat(value) : null;
        } else if (mode === 'rotate') {
            this.transformControls.rotationSnap = enabled ? THREE.MathUtils.degToRad(parseFloat(value)) : null;
        }
    }

    updateLockState(id, isLocked) {
        const monitor = this.monitors.find(m => m.userData.id === id);
        if (monitor) {
            monitor.userData.locked = isLocked;
            if (this.transformControls.object === monitor && isLocked) {
                this.transformControls.detach();
            }
        }
    }

    addOrUpdateMonitor(config, prevTransform = null) {
        this.removeMonitorMesh(config.id);
        
        const group = MonitorFactory.createMonitor(config);
        
        if (prevTransform) {
            group.position.copy(prevTransform.position);
            group.rotation.x = prevTransform.rotation.x;
            group.rotation.y = prevTransform.rotation.y;
        } else {
            group.position.set(0, group.userData.distanceToBottom + 50, 0);
        }

        this.scene.add(group);
        this.monitors.push(group);
        
        if (!config.locked) {
            this.selectMonitor(group);
        }
    }

    removeMonitorMesh(id) {
        const idx = this.monitors.findIndex(m => m.userData.id === id);
        if (idx > -1) {
            const obj = this.monitors[idx];
            if (this.transformControls.object === obj) this.transformControls.detach();
            this.scene.remove(obj);
            this.monitors.splice(idx, 1);
            
            obj.traverse(c => {
                if (c.isMesh) {
                    c.geometry.dispose();
                    if(c.material) {
                        if(Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                        else c.material.dispose();
                    }
                    if(c.material.map) c.material.map.dispose();
                }
            });
        }
    }

    onPointerDown(event) {
        if (this.transformControls.dragging || this.transformControls.axis) return;

        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        
        const intersects = this.raycaster.intersectObjects(this.monitors, true);

        if (intersects.length > 0) {
            for (let i = 0; i < intersects.length; i++) {
                let target = intersects[i].object;

                while (target && target !== this.scene && (!target.userData || !target.userData.isMonitor)) {
                    target = target.parent;
                }

                if (target && target.userData && target.userData.isMonitor) {
                    if (target.userData.locked) continue;

                    if (this.transformControls.object === target) {
                        const currentMode = this.transformControls.getMode();
                        this.transformControls.setMode(currentMode === 'translate' ? 'rotate' : 'translate');
                    } else {
                        this.selectMonitor(target);
                        this.transformControls.setMode('translate');
                    }
                    return;
                }
            }
        }
        
        this.transformControls.detach();
    }

    selectMonitor(obj) { 
        if (this.transformControls.parent !== this.scene) {
            this.scene.add(this.transformControls);
        }
        this.transformControls.attach(obj); 
    }

    onResize() {
        if (!this.container) return;
        this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    }

    animate(time) {
        requestAnimationFrame((t) => this.animate(t));

        // [최적화] 30 FPS 제한 로직
        if (!this.lastRenderTime) this.lastRenderTime = 0;
        const fpsInterval = 1000 / 30; // 30 FPS 목표
        const elapsed = time - this.lastRenderTime;

        if (elapsed > fpsInterval) {
            this.lastRenderTime = time - (elapsed % fpsInterval);

            this.orbitControls.update();
            this.renderer.render(this.scene, this.camera);
        }
    }
}

// ==========================================
// 3. App: UI Event Handling
// ==========================================
class App {
    constructor() {
        this.sceneManager = new SceneManager(document.getElementById('canvas-container'));
        this.monitorList = [];
        this.idCounter = 0;
        
        // 다국어 설정
        this.currentLang = 'ko'; // 기본값 한국어
        this.translations = {
            ko: {
                appTitle: "Multi-Monitor Planner",
                deskSetup: "데스크 설정",
                width: "너비(mm)",
                depth: "깊이(mm)",
                color: "색상",
                settings: "설정",
                language: "언어",
                snap: "스냅 (Snap)",
                monitors: "모니터 목록",
                addMonitor: "+ 모니터 추가",
                // Dynamic Items
                sizeInch: "크기 (인치)",
                ratio: "비율 (W:H)",
                type: "형태",
                flat: "평면",
                curved: "커브드",
                lock: "잠금",
                reset: "위치 초기화",
                remove: "삭제"
            },
            en: {
                appTitle: "Multi-Monitor Planner",
                deskSetup: "Desk Setup",
                width: "Width(mm)",
                depth: "Depth(mm)",
                color: "Color",
                settings: "Settings",
                language: "Language",
                snap: "Snap",
                monitors: "Monitors",
                addMonitor: "+ Add Monitor",
                // Dynamic Items
                sizeInch: "Size (inch)",
                ratio: "Ratio (W:H)",
                type: "Type",
                flat: "Flat",
                curved: "Curved",
                lock: "Lock",
                reset: "Reset Position",
                remove: "Remove"
            }
        };

        this.initEvents();
        this.initSidebarResize(); 
        this.sceneManager.updateDesk(1800, 800, '#ffffff');
        
        setTimeout(() => {
            this.sceneManager.onResize();
        }, 0);
    }

    initEvents() {
        const updateDesk = () => {
            const w = parseFloat(document.getElementById('desk-width').value) || 1800;
            const d = parseFloat(document.getElementById('desk-depth').value) || 800;
            const c = document.getElementById('desk-color').value || '#ffffff';
            this.sceneManager.updateDesk(w, d, c);
        };
        ['desk-width', 'desk-depth', 'desk-color'].forEach(id => {
            const el = document.getElementById(id);
            if(el) el.addEventListener('input', updateDesk);
        });

        document.getElementById('add-monitor-btn').addEventListener('click', () => this.addMonitor());
        
        // 언어 변경 이벤트
        const langSelect = document.getElementById('language-select');
        if (langSelect) {
            langSelect.value = this.currentLang;
            langSelect.addEventListener('change', (e) => {
                this.currentLang = e.target.value;
                this.updateLanguage();
            });
        }
        // 초기 언어 적용
        this.updateLanguage();

        const bindSnap = (checkId, rangeId, valId, type) => {
            const check = document.getElementById(checkId);
            const range = document.getElementById(rangeId);
            const val = document.getElementById(valId);
            
            const updateSnap = () => {
                const enabled = check.checked;
                const value = range.value;
                val.textContent = type === 'translate' ? `${value}mm` : `${value}°`;
                this.sceneManager.setSnap(type, enabled, value);
            };

            check.addEventListener('change', updateSnap);
            range.addEventListener('input', updateSnap);
            updateSnap();
        };

        bindSnap('snap-move-check', 'snap-move-range', 'snap-move-val', 'translate');
        bindSnap('snap-rotate-check', 'snap-rotate-range', 'snap-rotate-val', 'rotate');

        this.addMonitor();
    }

    initSidebarResize() {
        const sidebar = document.getElementById('sidebar');
        const resizer = document.getElementById('resizer');
        let isResizing = false;

        if(!resizer) return;

        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            let newWidth = e.clientX;
            if (newWidth < 280) newWidth = 280;
            if (newWidth > 600) newWidth = 600;
            
            sidebar.style.width = `${newWidth}px`;
            this.sceneManager.onResize();
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = 'default';
            }
        });
    }

    addMonitor() {
        const id = ++this.idCounter;
        const config = {
            id: id,
            name: `Monitor ${id}`,
            inches: 27,
            ratioW: 16,
            ratioH: 9,
            curvature: 0,
            isPortrait: false,
            locked: false
        };
        this.monitorList.push(config);
        this.renderList();
        this.sceneManager.addOrUpdateMonitor(config);
    }

    toggleLock(id) {
        const config = this.monitorList.find(m => m.id === id);
        if (!config) return;

        config.locked = !config.locked;
        this.sceneManager.updateLockState(id, config.locked);
        this.renderList();
    }

    resetMonitor(id) {
        const config = this.monitorList.find(m => m.id === id);
        if (!config || config.locked) return; // 잠긴 상태면 리셋 방지

        // 두 번째 인자로 null을 전달하여 위치/회전 강제 초기화
        this.sceneManager.addOrUpdateMonitor(config, null);
    }

    updateLanguage() {
        const t = this.translations[this.currentLang];
        
        // 정적 텍스트 업데이트
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            if (t[key]) el.textContent = t[key];
        });

        // 모니터 리스트 재생성 (동적 텍스트 업데이트)
        this.renderList();
    }

    renderList() {
        const listEl = document.getElementById('monitor-list');
        listEl.innerHTML = '';
        const t = this.translations[this.currentLang]; // 현재 언어 팩

        this.monitorList.forEach((config, index) => {
            const item = document.createElement('div');
            item.className = 'monitor-item';
            const upDisabled = index === 0 ? 'disabled' : '';
            const downDisabled = index === this.monitorList.length - 1 ? 'disabled' : '';

            const isCurved = config.curvature > 0;
            const rotateBtnDisplay = isCurved ? 'inline-block' : 'none';
            const rotateBtnClass = config.isPortrait ? 'btn-icon active' : 'btn-icon';

            const lockBtnClass = config.locked ? 'btn-icon active' : 'btn-icon';
            const lockIcon = `
                <svg viewBox="0 0 24 24">
                    <path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6z"/>
                </svg>
            `;
            const resetIcon = `
                <svg viewBox="0 0 24 24">
                    <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                </svg>
            `;
            const pivotIcon = `
                <svg viewBox="0 0 24 24">
                    <path d="M16.48 2.52c3.27 1.55 5.61 4.72 5.97 8.48h1.5C23.44 4.84 18.29 0 12 0l-.66.03 3.81 3.81 1.33-1.32zm-6.25-.77c-.59-.59-1.54-.59-2.12 0L1.75 8.11c-.59.59-.59 1.54 0 2.12l12.02 12.02c.59.59 1.54.59 2.12 0l6.36-6.36c.59-.59.59-1.54 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zm-7.31.29C4.25 19.94 1.91 16.76 1.55 13H.05C.56 19.16 5.71 24 12 24l.66-.03-3.81-3.81-1.33 1.32z"/>
                </svg>
            `;

            item.innerHTML = `
                <div class="monitor-header">
                    <span>${config.name}</span>
                    <div class="order-controls">
                        <button class="${lockBtnClass}" onclick="window.toggleLock(${config.id})" title="${t.lock}">
                            ${lockIcon}
                        </button>
                        <button class="btn-icon" onclick="window.resetMonitor(${config.id})" title="${t.reset}">
                            ${resetIcon}
                        </button>
                        <button class="btn-icon" onclick="window.moveItem(${index}, -1)" ${upDisabled}>▲</button>
                        <button class="btn-icon" onclick="window.moveItem(${index}, 1)" ${downDisabled}>▼</button>
                        <button class="btn-danger" onclick="window.removeMonitor(${config.id})" style="margin-left:5px" title="${t.remove}">X</button>
                    </div>
                </div>

                <div style="display: flex; gap: 10px; align-items: flex-end; margin-bottom: 10px;">
                    <div style="flex: 1;">
                        <label style="display:block; font-size:12px; margin-bottom:4px; color:#888;">${t.sizeInch}</label>
                        <input type="number" value="${config.inches}" style="width:100%; box-sizing:border-box;"
                               onchange="window.updateMonitor(${config.id}, 'inches', this.value)">
                    </div>
                    <div style="flex: 1.2;">
                        <label style="display:block; font-size:12px; margin-bottom:4px; color:#888;">${t.ratio}</label>
                        <div style="display: flex; gap: 2px;">
                            <input type="number" value="${config.ratioW}" style="width:100%;"
                                   onchange="window.updateMonitor(${config.id}, 'ratioW', this.value)">
                            <button class="btn-swap" onclick="window.swapRatio(${config.id})" title="Swap">↔</button>
                            <input type="number" value="${config.ratioH}" style="width:100%;"
                                   onchange="window.updateMonitor(${config.id}, 'ratioH', this.value)">
                        </div>
                    </div>
                </div>

                <div class="control-group">
                    <label style="display:block; font-size:12px; margin-bottom:4px; color:#888;">${t.type}</label>
                    <div style="display:flex; gap: 15px; margin-bottom: 5px;">
                        <label style="cursor:pointer; display:flex; align-items:center; gap:5px;">
                            <input type="radio" name="ctype-${config.id}" 
                                   ${!isCurved ? 'checked' : ''} 
                                   onchange="window.setCurvatureType(${config.id}, 'flat')">
                            ${t.flat}
                        </label>
                        <label style="cursor:pointer; display:flex; align-items:center; gap:5px;">
                            <input type="radio" name="ctype-${config.id}" 
                                   ${isCurved ? 'checked' : ''} 
                                   onchange="window.setCurvatureType(${config.id}, 'curved')">
                            ${t.curved}
                        </label>
                        
                        <button class="${rotateBtnClass}" style="margin-left:auto; display:${rotateBtnDisplay};" 
                            onclick="window.rotateMonitor(${config.id})" 
                            title="Rotate 90°">
                            ${pivotIcon}
                        </button>
                    </div>

                    <div id="curve-controls-${config.id}" style="display: ${isCurved ? 'flex' : 'none'}; align-items: center; gap: 5px; margin-top:5px;">
                        <input type="range" min="800" max="4000" step="100" value="${config.curvature || 1500}" 
                            oninput="document.getElementById('curv-val-${config.id}').textContent = this.value + 'R'; window.updateMonitor(${config.id}, 'curvature', this.value)">
                        
                        <span id="curv-val-${config.id}" class="setting-value">${config.curvature || 1500}R</span>
                    </div>
                </div>
            `;
            listEl.appendChild(item);
        });
    }

    setCurvatureType(id, type) {
        const config = this.monitorList.find(m => m.id === id);
        if (!config) return;

        if (type === 'flat') {
            config.curvature = 0;
        } else {
            if (config.curvature <= 0) config.curvature = 1500;
        }
        
        this.renderList();
        this.refresh3D(config);
    }

    updateMonitor(id, key, value) {
        const config = this.monitorList.find(m => m.id === id);
        if (!config) return;

        let parsed = parseFloat(value);
        if (key === 'inches') parsed = Math.max(1, parsed || 27);
        if (key === 'ratioW') parsed = Math.max(0.1, parsed || 16);
        if (key === 'ratioH') parsed = Math.max(0.1, parsed || 9);
        
        config[key] = parsed;

        this.refresh3D(config);
    }

    swapRatio(id) {
        const config = this.monitorList.find(m => m.id === id);
        if (!config) return;

        const temp = config.ratioW;
        config.ratioW = config.ratioH;
        config.ratioH = temp;

        this.renderList();
        this.refresh3D(config);
    }
    
    rotateMonitor(id) {
        const config = this.monitorList.find(m => m.id === id);
        if (!config) return;
        
        config.isPortrait = !config.isPortrait;
        
        this.renderList(); 
        this.refresh3D(config);
    }

    refresh3D(config) {
        const oldObj = this.sceneManager.monitors.find(m => m.userData.id === config.id);
        let prevTransform = null;
        if (oldObj) {
            prevTransform = {
                position: oldObj.position.clone(),
                rotation: oldObj.rotation.clone()
            };
        }
        this.sceneManager.addOrUpdateMonitor(config, prevTransform);
        this.validateMonitor(config.id);
    }

    validateMonitor(id) {
        const monitor = this.sceneManager.monitors.find(m => m.userData.id === id);
        const config = this.monitorList.find(m => m.id === id);
        
        if (!config) return;

        let isValid = true;
        if (!monitor) isValid = false;
        if (isValid) {
            const { x, y, z } = monitor.position;
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                isValid = false;
            }
        }

        if (!isValid) {
            console.warn(`Monitor ${id} rendering issue detected. Resetting.`);
            this.sceneManager.addOrUpdateMonitor(config, null); 
        }
    }

    moveItem(index, direction) {
        if (index + direction < 0 || index + direction >= this.monitorList.length) return;
        const temp = this.monitorList[index];
        this.monitorList[index] = this.monitorList[index + direction];
        this.monitorList[index + direction] = temp;
        this.renderList();
    }

    removeMonitor(id) {
        this.monitorList = this.monitorList.filter(m => m.id !== id);
        this.sceneManager.removeMonitorMesh(id);
        this.renderList();
    }
}

window.updateMonitor = (id, key, val) => window.appInstance.updateMonitor(id, key, val);
window.setCurvatureType = (id, type) => window.appInstance.setCurvatureType(id, type);
window.swapRatio = (id) => window.appInstance.swapRatio(id);
window.rotateMonitor = (id) => window.appInstance.rotateMonitor(id);
window.moveItem = (idx, dir) => window.appInstance.moveItem(idx, dir);
window.removeMonitor = (id) => window.appInstance.removeMonitor(id);
window.toggleLock = (id) => window.appInstance.toggleLock(id); 
window.resetMonitor = (id) => window.appInstance.resetMonitor(id);

window.appInstance = new App();