// AudioDrop background removal: U2-Net models running locally through ONNX Runtime Web.
// The picture never leaves the computer.
//   AudioDropBgRemove.prepare(loadBytes, model) -> Promise<string>   (runtime once, each model once)
//   AudioDropBgRemove.run(sourceCanvas, model)  -> Promise<canvas>   (same size, background transparent)
// model: 'u2netp' (small, fast) or 'silueta' (larger, more accurate)
(function (global) {
    'use strict';
    var SIZE = 320;
    var runtimePromise = null;
    var sessions = {};

    // The runtime is started once. The faster SIMD build is used only when this
    // browser engine accepts that exact file; otherwise the plain build.
    function startRuntime(loadBytes) {
        if (runtimePromise) return runtimePromise;
        runtimePromise = Promise.resolve().then(function () {
            if (!global.ort) throw new Error('ONNX Runtime yuklanmagan');
            return loadBytes('ort-wasm-simd.wasm').then(function (bytes) {
                var usable = false;
                try { usable = WebAssembly.validate(bytes); } catch (e) { usable = false; }
                return usable ? { bytes: bytes, simd: true } : null;
            }, function () { return null; });
        }).then(function (simdBuild) {
            if (simdBuild) return simdBuild;
            return loadBytes('ort-wasm.wasm').then(function (bytes) { return { bytes: bytes, simd: false }; });
        }).then(function (build) {
            global.ort.env.wasm.numThreads = 1;
            global.ort.env.wasm.simd = build.simd;
            global.ort.env.wasm.wasmBinary = build.bytes;
            return build.simd ? 'simd' : 'oddiy';
        });
        runtimePromise.catch(function () { runtimePromise = null; });
        return runtimePromise;
    }

    function prepare(loadBytes, model) {
        var name = model === 'silueta' ? 'silueta' : 'u2netp';
        if (sessions[name]) return sessions[name].then(function (ready) { return ready.info; });
        sessions[name] = startRuntime(loadBytes).then(function (kind) {
            return loadBytes(name + '.onnx').then(function (bytes) {
                return global.ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
            }).then(function (session) {
                return { session: session, info: name + ' ' + kind };
            });
        });
        sessions[name].catch(function () { delete sessions[name]; });
        return sessions[name].then(function (ready) { return ready.info; });
    }

    function run(sourceCanvas, model) {
        var name = model === 'silueta' ? 'silueta' : 'u2netp';
        if (!sessions[name]) return Promise.reject(new Error('Fon moduli tayyorlanmagan'));
        var width = sourceCanvas.width;
        var height = sourceCanvas.height;
        return sessions[name].then(function (ready) {
            var session = ready.session;
            // 1) network input: 320x320, ImageNet normalisation, channels first
            var small = document.createElement('canvas');
            small.width = SIZE;
            small.height = SIZE;
            var smallCtx = small.getContext('2d');
            smallCtx.drawImage(sourceCanvas, 0, 0, SIZE, SIZE);
            var pixels = smallCtx.getImageData(0, 0, SIZE, SIZE).data;
            var area = SIZE * SIZE;
            var input = new Float32Array(3 * area);
            var peak = 1;
            var i;
            for (i = 0; i < pixels.length; i++) { if ((i & 3) !== 3 && pixels[i] > peak) peak = pixels[i]; }
            var mean = [0.485, 0.456, 0.406];
            var std = [0.229, 0.224, 0.225];
            for (i = 0; i < area; i++) {
                input[i] = (pixels[i * 4] / peak - mean[0]) / std[0];
                input[area + i] = (pixels[i * 4 + 1] / peak - mean[1]) / std[1];
                input[2 * area + i] = (pixels[i * 4 + 2] / peak - mean[2]) / std[2];
            }
            var feeds = {};
            feeds[session.inputNames[0]] = new global.ort.Tensor('float32', input, [1, 3, SIZE, SIZE]);
            return session.run(feeds).then(function (results) {
                var output = results[session.outputNames[0]].data;
                var low = Infinity;
                var high = -Infinity;
                for (i = 0; i < area; i++) {
                    if (output[i] < low) low = output[i];
                    if (output[i] > high) high = output[i];
                }
                var range = (high - low) || 1;
                // 2) the mask as a small picture whose transparency is the mask
                var maskCanvas = document.createElement('canvas');
                maskCanvas.width = SIZE;
                maskCanvas.height = SIZE;
                var maskCtx = maskCanvas.getContext('2d');
                var maskData = maskCtx.createImageData(SIZE, SIZE);
                for (i = 0; i < area; i++) {
                    var value = (output[i] - low) / range;
                    // steepen the edge a little so soft halos do not survive
                    value = Math.max(0, Math.min(1, (value - 0.15) / 0.7));
                    maskData.data[i * 4] = 255;
                    maskData.data[i * 4 + 1] = 255;
                    maskData.data[i * 4 + 2] = 255;
                    maskData.data[i * 4 + 3] = Math.round(value * 255);
                }
                maskCtx.putImageData(maskData, 0, 0);

                // 3) the picture kept only where the mask is, done by the canvas
                //    itself (no per-pixel loop over the full-size picture)
                var result = document.createElement('canvas');
                result.width = width;
                result.height = height;
                var resultCtx = result.getContext('2d');
                resultCtx.drawImage(sourceCanvas, 0, 0);
                resultCtx.globalCompositeOperation = 'destination-in';
                resultCtx.imageSmoothingEnabled = true;
                resultCtx.imageSmoothingQuality = 'high';
                resultCtx.drawImage(maskCanvas, 0, 0, width, height);
                resultCtx.globalCompositeOperation = 'source-over';
                return result;
            });
        });
    }

    global.AudioDropBgRemove = { prepare: prepare, run: run };
})(window);
