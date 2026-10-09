// DROP+ for DaVinci Resolve Studio - bridge between the panel and Resolve.
// The panel was written for Adobe hosts and talks to them through CSInterface
// and window.cep. Here the same two objects exist, but they drive Resolve.
const path = require('path');
const fs = require('fs');
const { ipcRenderer } = require('electron');

const PLUGIN_ID = 'com.dropplus.resolve';
let WorkflowIntegration = null;
let resolveObject = null;
let loadError = '';

try {
    WorkflowIntegration = require('./WorkflowIntegration.node');
} catch (error) {
    loadError = String(error && error.message || error);
}

function log(kind, text) {
    try {
        fs.appendFileSync(path.join(__dirname, 'dropplus-resolve-log.txt'),
            new Date().toISOString() + ' | ' + kind + ' | ' + String(text) + '\r\n');
    } catch (e) { }
}

function getResolve() {
    if (resolveObject) return resolveObject;
    if (!WorkflowIntegration) throw new Error('WorkflowIntegration.node yuklanmadi: ' + loadError);
    if (!WorkflowIntegration.Initialize(PLUGIN_ID)) throw new Error('DaVinci Resolve bilan aloqa o‘rnatilmadi');
    resolveObject = WorkflowIntegration.GetResolve();
    if (!resolveObject) throw new Error('DaVinci Resolve obyekti olinmadi');
    return resolveObject;
}

function currentProject() {
    const manager = getResolve().GetProjectManager();
    return manager ? manager.GetCurrentProject() : null;
}

function timecodeToFrames(timecode, fps) {
    const parts = String(timecode || '').split(/[:;]/).map(function (p) { return parseInt(p, 10) || 0; });
    while (parts.length < 4) parts.unshift(0);
    const base = Math.round(fps);
    return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * base + parts[3];
}

function findOrCreateBin(mediaPool, name) {
    const root = mediaPool.GetRootFolder();
    const folders = root.GetSubFolderList() || [];
    for (let i = 0; i < folders.length; i++) {
        if (folders[i].GetName() === name) return folders[i];
    }
    return mediaPool.AddSubFolder(root, name) || root;
}

function samePath(a, b) {
    return String(a || '').replace(/\//g, '\\').toLowerCase() === String(b || '').replace(/\//g, '\\').toLowerCase();
}

function importIntoBin(mediaPool, bin, filePath) {
    const clips = bin.GetClipList() || [];
    for (let i = 0; i < clips.length; i++) {
        if (samePath(clips[i].GetClipProperty('File Path'), filePath)) return clips[i];
    }
    const previous = mediaPool.GetCurrentFolder();
    mediaPool.SetCurrentFolder(bin);
    const imported = mediaPool.ImportMedia([filePath]);
    try { if (previous) mediaPool.SetCurrentFolder(previous); } catch (e) { }
    return imported && imported.length ? imported[0] : null;
}

function trackIsFree(timeline, type, index, start, end) {
    try { if (timeline.GetIsTrackLocked(type, index)) return false; } catch (e) { }
    const items = timeline.GetItemListInTrack(type, index) || [];
    for (let i = 0; i < items.length; i++) {
        if (items[i].GetStart() < end && items[i].GetEnd() > start) return false;
    }
    return true;
}

// The lowest track that is empty for the whole length of the new clip; a new
// track is added only when every existing one is occupied there.
function freeTrack(timeline, type, start, end) {
    const count = timeline.GetTrackCount(type);
    for (let index = 1; index <= count; index++) {
        if (trackIsFree(timeline, type, index, start, end)) return index;
    }
    if (!timeline.AddTrack(type)) return 0;
    return timeline.GetTrackCount(type);
}

function clipFrames(item, timelineFps) {
    let frames = parseInt(item.GetClipProperty('Frames'), 10);
    const clipFps = parseFloat(item.GetClipProperty('FPS')) || timelineFps;
    if (!frames || frames < 1) {
        frames = timecodeToFrames(item.GetClipProperty('Duration'), clipFps);
    }
    return { source: Math.max(1, frames), timeline: Math.max(1, Math.round(frames * timelineFps / clipFps)) };
}

function place(filePath, kind) {
    const diag = [];
    const labels = { music: 'Musiqa', video: 'Video', image: 'Rasm' };
    const bins = { music: 'DROP+ Musiqa', video: 'DROP+ Video', image: 'DROP+ Rasm' };
    try {
        if (!fs.existsSync(filePath)) return { success: false, message: 'Fayl diskda topilmadi: ' + filePath };
        const project = currentProject();
        if (!project) return { success: false, message: 'DaVinci Resolve’da loyiha ochilmagan.' };
        const mediaPool = project.GetMediaPool();
        const item = importIntoBin(mediaPool, findOrCreateBin(mediaPool, bins[kind]), filePath);
        if (!item) return { success: false, message: labels[kind] + ' Media Pool’ga import qilinmadi: ' + filePath };

        const timeline = project.GetCurrentTimeline();
        if (!timeline) {
            return { success: false, message: labels[kind] + ' Media Pool’ga qo‘shildi. Ochiq timeline yo‘q, shuning uchun Timeline’ga qo‘yilmadi.' };
        }

        const fps = parseFloat(timeline.GetSetting('timelineFrameRate')) || 25;
        const record = timecodeToFrames(timeline.GetCurrentTimecode(), fps);
        let length = clipFrames(item, fps);
        if (kind === 'image') length = { source: Math.round(fps) * 5, timeline: Math.round(fps) * 5 };
        const end = record + length.timeline;
        diag.push('fps=' + fps + ' playhead=' + record + ' frames=' + length.timeline);

        const entries = [];
        let videoTrack = 0, audioTrack = 0;
        if (kind !== 'music') {
            videoTrack = freeTrack(timeline, 'video', record, end);
            if (!videoTrack) return { success: false, diag: diag.join(' | '), message: labels[kind] + ' Media Pool’ga qo‘shildi, lekin bo‘sh video trek yo‘q va yangi trek qo‘shilmadi.' };
            entries.push({ mediaPoolItem: item, startFrame: 0, endFrame: length.source - 1, mediaType: 1, trackIndex: videoTrack, recordFrame: record });
        }
        const audioChannels = parseInt(item.GetClipProperty('Audio Ch'), 10) || 0;
        if (kind === 'music' || (kind === 'video' && audioChannels > 0)) {
            audioTrack = freeTrack(timeline, 'audio', record, end);
            if (!audioTrack) return { success: false, diag: diag.join(' | '), message: labels[kind] + ' Media Pool’ga qo‘shildi, lekin bo‘sh audio trek yo‘q va yangi trek qo‘shilmadi.' };
            entries.push({ mediaPoolItem: item, startFrame: 0, endFrame: length.source - 1, mediaType: 2, trackIndex: audioTrack, recordFrame: record });
        }
        diag.push('so‘raldi V' + videoTrack + '/A' + audioTrack + '@' + record);

        const placed = mediaPool.AppendToTimeline(entries) || [];
        const starts = [];
        let wrong = placed.length !== entries.length;
        for (let i = 0; i < placed.length; i++) {
            const start = placed[i] ? placed[i].GetStart() : -1;
            starts.push(start);
            if (Math.abs(start - record) > 1) wrong = true;
        }
        diag.push('tushdi ' + placed.length + '/' + entries.length + ' @' + starts.join(','));
        if (wrong) {
            let removed = false;
            try { removed = placed.length ? !!timeline.DeleteClips(placed, false) : true; } catch (e) { }
            return {
                success: false, diag: diag.join(' | '),
                message: labels[kind] + ' Media Pool’ga qo‘shildi, lekin Timeline’da kerakli joyga tushmadi' +
                    (removed ? ' va qaytarib olindi.' : ' (Ctrl+Z bosing).')
            };
        }
        const where = [videoTrack ? 'V' + videoTrack : '', audioTrack ? 'A' + audioTrack : ''].filter(Boolean).join(', ');
        return { success: true, diag: diag.join(' | '), message: labels[kind] + ' Timeline’ga qo‘shildi (' + where + ').' };
    } catch (error) {
        return { success: false, diag: diag.join(' | '), message: 'DaVinci Resolve xatoligi: ' + String(error && error.message || error) };
    }
}

function status() {
    try {
        const project = currentProject();
        if (!project) return { success: false, message: 'Loyiha (Project) ochilmagan' };
        const timeline = project.GetCurrentTimeline();
        return {
            success: true,
            projectName: project.GetName() || 'Nomsiz loyiha',
            hasActiveSequence: !!timeline,
            sequenceName: timeline ? timeline.GetName() : 'Timeline yo‘q'
        };
    } catch (error) {
        return { success: false, message: String(error && error.message || error) };
    }
}

// The panel sends the same script text it would send to an Adobe host.
function runHostScript(script) {
    const text = String(script || '');
    if (/^\s*testPremiereConnection\(\)/.test(text)) return status();
    let match = /^\s*importAndInsertToTimeline\((".*")\)\s*$/.exec(text);
    if (match) return place(JSON.parse(match[1]), 'music');
    match = /^\s*importAndInsert(Video|Image)ToTimeline\(decodeURIComponent\('(.*)'\)(?:\s*,\s*(?:true|false))?\)\s*$/.exec(text);
    if (match) return place(decodeURIComponent(match[2]), match[1] === 'Video' ? 'video' : 'image');
    return { success: false, message: 'Noma’lum buyruq' };
}

function CSInterface() { }
CSInterface.prototype.getSystemPath = function () { return __dirname; };
CSInterface.prototype.evalScript = function (script, callback) {
    setTimeout(function () {
        const started = Date.now();
        const result = runHostScript(script);
        if (!/testPremiereConnection/.test(String(script))) {
            log(result.success ? 'OK' : 'RAD', (result.message || '') + ' | ' + (result.diag || '') + ' | ' + (Date.now() - started) + 'ms');
        }
        if (typeof callback === 'function') callback(JSON.stringify(result));
    }, 0);
};
window.CSInterface = CSInterface;

window.cep = {
    fs: {
        showSaveDialogEx: function (title, initialPath, fileTypes, defaultName) {
            return ipcRenderer.sendSync('drop-dialog', { type: 'save', title: title, initialPath: initialPath, fileTypes: fileTypes, defaultName: defaultName });
        },
        showOpenDialogEx: function (allowMultiple, chooseDirectory, title, initialPath, fileTypes) {
            return ipcRenderer.sendSync('drop-dialog', { type: 'open', allowMultiple: allowMultiple, chooseDirectory: chooseDirectory, title: title, initialPath: initialPath, fileTypes: fileTypes });
        }
    }
};

window.addEventListener('beforeunload', function () {
    try { if (WorkflowIntegration && resolveObject) WorkflowIntegration.CleanUp(); } catch (e) { }
});

// Exposed for tests only.
window.__dropResolve = { runHostScript: runHostScript, timecodeToFrames: timecodeToFrames };
