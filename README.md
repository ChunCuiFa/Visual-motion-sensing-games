# 体感健身游戏原型（打砖块 / 弹珠）

用一台普通摄像头 + 姿态识别，把客厅变成体感健身房。纯前端，无构建步骤，不依赖外网 CDN。

- **打砖块（体感光剑）**：蓝色方块用手挥、橙色方块用脚踢，方块到达格子的瞬间把对应部位送进去。
- **弹珠**：身体左右移动控制底部平台把球弹回；张开双臂或劈开双腿可以**加宽平台**；用手/脚拾取道具换取存活效果（平台加宽、小球减速，每 4 个道具 +1 命）。

完整设计、参数与排查方法见 [体感光剑原型设计.md](./体感光剑原型设计.md)。

## 运行

在 `prototype/` 目录启动静态服务器，然后用 Chrome 打开 `http://localhost:8000`：

```bash
cd prototype
node serve.mjs 8000        # 或者：python -m http.server 8000
```

摄像头只在安全来源（`localhost` 或 https）下可用，**不要直接双击打开 `index.html`**：`file://` 下 ES 模块与 wasm 都无法加载。

## 目录

| 路径 | 作用 |
|---|---|
| `prototype/index.html` | 页面、控件与 HUD |
| `prototype/app.js` | 主线程：摄像头、抽帧、滤波、节拍/物理、判定与渲染 |
| `prototype/worker.js` | Web Worker：MediaPipe 姿态推理（避免阻塞界面） |
| `prototype/serve.mjs` | 极简静态服务器（正确的 .wasm MIME + no-cache） |
| `prototype/vendor/` | 本地化的 MediaPipe Tasks Vision 运行时 |
| `prototype/models/` | 本地化的姿态模型（pose_landmarker_lite） |

## 环境要求

- Chrome 或 Edge（需要 ES 模块 Worker、`requestVideoFrameCallback`、WebGL）。
- 摄像头（任意 UVC 设备均可，外接相机如 DJI Osmo Action / Pocket 的 Webcam 模式也能用）。

## 延迟提示

如果觉得反应慢，先打开**电视/显示器的"游戏模式"**（省得最多），再用手机 60fps 录制来测量真实总延迟 —— 方法见设计文档第 9.2、9.3 节。
