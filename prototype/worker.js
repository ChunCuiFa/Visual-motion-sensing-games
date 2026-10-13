import { FilesetResolver, PoseLandmarker } from "./vendor/mediapipe/vision_bundle.mjs";

// MediaPipe 的 wasm 加载器在 worker 中会调用 importScripts，而模块化 worker 禁止该 API。
// 这里提供一个同步版本：用同步 XHR 取回脚本内容，再以间接 eval 在全局作用域执行。
Object.defineProperty(self, "importScripts", {
  configurable: true,
  writable: true,
  value: (...urls) => {
    for (const url of urls) {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.send();
      if (xhr.status < 200 || xhr.status >= 300) {
        throw new Error(`加载脚本失败: ${url} (${xhr.status})`);
      }
      (0, eval)(`${xhr.responseText}\n//# sourceURL=${url}`);
    }
  },
});

let landmarker = null;

async function init(wasmPath, modelPath) {
  const fileset = await FilesetResolver.forVisionTasks(wasmPath);
  const base = { modelAssetPath: modelPath };
  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      runningMode: "VIDEO",
      numPoses: 1,
      baseOptions: { ...base, delegate: "GPU" },
    });
    self.postMessage({ type: "ready", delegate: "GPU" });
  } catch {
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      runningMode: "VIDEO",
      numPoses: 1,
      baseOptions: { ...base, delegate: "CPU" },
    });
    self.postMessage({ type: "ready", delegate: "CPU" });
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    try {
      await init(msg.wasmPath, msg.modelPath);
    } catch (err) {
      self.postMessage({ type: "error", message: String((err && err.message) || err) });
    }
    return;
  }
  if (msg.type === "frame" && landmarker) {
    const { bitmap, ts } = msg;
    let landmarks = null;
    try {
      const result = landmarker.detectForVideo(bitmap, ts);
      landmarks = result.landmarks && result.landmarks[0] ? result.landmarks[0] : null;
    } catch (err) {
      landmarks = null;
    } finally {
      bitmap.close();
    }
    self.postMessage({ type: "pose", ts, landmarks });
  }
};
