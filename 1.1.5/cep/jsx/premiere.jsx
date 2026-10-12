// AudioDrop ExtendScript for Adobe Premiere Pro

// Lightweight JSON polyfill for ExtendScript (ES3)
if (typeof JSON === "undefined") {
    JSON = {};
}
if (!JSON.stringify) {
    JSON.stringify = function (obj) {
        var t = typeof obj;
        if (t !== "object" || obj === null) {
            if (t === "string") return '"' + obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
            return String(obj);
        } else {
            var n, v, json = [], isArr = (obj && obj.constructor === Array);
            for (n in obj) {
                if (obj.hasOwnProperty(n)) {
                    v = obj[n];
                    t = typeof v;
                    if (t === "string") v = '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
                    else if (t === "object" && v !== null) v = JSON.stringify(v);
                    json.push((isArr ? "" : '"' + n + '":') + String(v));
                }
            }
            return (isArr ? "[" : "{") + String(json) + (isArr ? "]" : "}");
        }
    };
}
if (!JSON.parse) {
    JSON.parse = function (str) {
        return eval("(" + str + ")");
    };
}

// Check Premiere Pro connection and return active project info
function testPremiereConnection() {
    try {
        if (!app.project) {
            return JSON.stringify({ success: false, message: "Loyiha (Project) ochilmagan" });
        }
        var projName = app.project.name || "Nomsiz loyiha";
        var hasSeq = !!app.project.activeSequence;
        var seqName = hasSeq ? app.project.activeSequence.name : "Sekvensiya yo'q";
        return JSON.stringify({
            success: true,
            projectName: projName,
            hasActiveSequence: hasSeq,
            sequenceName: seqName
        });
    } catch (e) {
        return JSON.stringify({ success: false, message: e.toString() });
    }
}

// Find or create a bin in the project
function getOrCreateBin(binName) {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        var item = root.children[i];
        if (item.type === ProjectItemType.BIN && item.name === binName) {
            return item;
        }
    }
    return root.createBin(binName);
}

// Normalize path for comparison
function normalizePath(p) {
    if (!p) return "";
    return p.replace(/\\/g, "/").toLowerCase();
}

// Find an item by media path among the direct children of one bin, newest
// first. The whole project is deliberately not searched: in a large project
// that walk alone took a long time on every single drop.
function findItemByMediaPath(container, targetPath) {
    var normTarget = normalizePath(targetPath);
    for (var i = container.children.numItems - 1; i >= 0; i--) {
        var child = container.children[i];
        if (!child || child.type === ProjectItemType.BIN) continue;
        var mediaPath = child.getMediaPath();
        if (mediaPath && normalizePath(mediaPath) === normTarget) return child;
    }
    return null;
}

// Main function: Import file and place it onto the active sequence timeline
function importAndInsertToTimeline(filePath) {
    try {
        if (!app.project) {
            return JSON.stringify({
                success: false,
                message: "Premiere Pro'da biron bir loyiha ochiq emas! Avval loyiha oching yoki yarating."
            });
        }

        var fileObj = new File(filePath);
        if (!fileObj.exists) {
            return JSON.stringify({
                success: false,
                message: "Fayl diskda topilmadi: " + filePath
            });
        }

        var musicBin = getOrCreateBin("DROP+ Musiqa");

        // Check if already in project
        var projectItem = findItemByMediaPath(musicBin, fileObj.fsName);

        // If not imported yet, import it
        if (!projectItem) {
            var fileList = [fileObj.fsName];
            var suppressUI = true;
            app.project.importFiles(fileList, suppressUI, musicBin, false);

            // Re-find the newly imported item
            projectItem = findItemByMediaPath(musicBin, fileObj.fsName);
            if (!projectItem) projectItem = findItemByMediaPath(app.project.rootItem, fileObj.fsName);
        }

        if (!projectItem) {
            return JSON.stringify({
                success: false,
                message: "Audio fayl Premiere Pro'ga import qilindi, ammo ProjectItem topilmadi."
            });
        }

        // Check active sequence
        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({
                success: true,
                inserted: false,
                message: "Musiqa 'DROP+ Musiqa' papkasiga qo'shildi! Hozirda faol Timeline (Sequence) yo'q. Sekvensiya ochsangiz, kursor turgan joyga avtomatik tushadi."
            });
        }

        // Put the music on the nearest free audio track right under the rows being
        // edited at the playhead. A new track is added only when none is free.
        var playheadTime = seq.getPlayerPosition();
        var musicStart = playheadTime.seconds;
        var musicEnd = getInsertRangeEnd(projectItem, musicStart);
        var musicTrackError = "";
        var targetTrackIndex = findNearestFreeTrackIndex(seq.audioTracks, musicStart, musicEnd);
        if (targetTrackIndex >= seq.audioTracks.numTracks) {
            musicTrackError = addSequenceTrack(seq, false);
            targetTrackIndex = findNearestFreeTrackIndex(seq.audioTracks, musicStart, musicEnd);
        }

        // Never overwrite or move existing clips.
        if (targetTrackIndex >= seq.audioTracks.numTracks ||
            !isTrackFreeInRange(seq.audioTracks[targetTrackIndex], musicStart, musicEnd)) {
            return JSON.stringify({
                success: false,
                inserted: false,
                message: "Audio loyihaga import qilindi, ammo bo'sh audio trek yo'q va Premiere yangi trek qo'sha olmadi. Hech bir klip o'zgartirilmadi. Timeline'da yangi audio trek qo'shib, qayta urinib ko'ring." + (musicTrackError ? " Sabab: " + musicTrackError : "")
            });
        }

        var targetTrack = seq.audioTracks[targetTrackIndex];

        // Place clip onto the timeline at current playhead position
        targetTrack.overwriteClip(projectItem, playheadTime);

        return JSON.stringify({
            success: true,
            inserted: true,
            trackName: "A" + (targetTrackIndex + 1),
            seconds: playheadTime.seconds,
            message: "Musiqa muvaffaqiyatli Timeline'ga (Audio " + (targetTrackIndex + 1) + ") qo'yildi!"
        });

    } catch (err) {
        return JSON.stringify({
            success: false,
            message: "ExtendScript xatoligi: " + err.toString()
        });
    }
}

// ---- Track placement helpers -------------------------------------------------
// A track counts as "free" when nothing on it overlaps the time range the new
// clip will occupy. Clips elsewhere on the same track do not matter.

function getInsertRangeEnd(projectItem, startSeconds) {
    var duration = -1;
    try {
        var outPoint = projectItem.getOutPoint();
        var inPoint = projectItem.getInPoint();
        if (outPoint && inPoint) duration = outPoint.seconds - inPoint.seconds;
    } catch (durationError) { }
    // Unknown length: treat everything after the playhead as needed, so an
    // existing clip can never be overwritten.
    if (!(duration > 0)) return 1e12;
    return startSeconds + duration;
}

function isTrackLockedSafe(track) {
    try {
        if (track && typeof track.isLocked === "function") return !!track.isLocked();
    } catch (lockError) { }
    return false;
}

function isTrackFreeInRange(track, startSeconds, endSeconds) {
    if (!track) return false;
    if (isTrackLockedSafe(track)) return false;
    var epsilon = 0.001;
    var clips = track.clips;
    // First clip that ends after the range starts; everything before it is irrelevant.
    var low = 0;
    var high = clips.numItems;
    while (low < high) {
        var middle = Math.floor((low + high) / 2);
        if (clips[middle].end.seconds > startSeconds + epsilon) high = middle;
        else low = middle + 1;
    }
    if (low >= clips.numItems) return true;
    return !(clips[low].start.seconds < endSeconds - epsilon);
}

// ---- Verified placement ---------------------------------------------------------
// Premiere versions read the time argument of Sequence.overwriteClip differently,
// and a wrong reading drops the clip at the sequence start, possibly on top of
// existing media. So nothing is assumed: the first time in a Premiere session
// the forms are tried in a throw-away test sequence, and only a form that was
// seen to land at the right time AND on the requested tracks is used on the
// editor's real timeline.

var AUDIODROP_TICKS_PER_SECOND = 254016000000;
// What was learned stays valid for the whole Premiere session, so it is kept
// when the panel is closed and reopened (this file is evaluated again then).
// A failed result ("none") is forgotten, to allow a fresh try.
var audioDropTimeForm = (typeof audioDropTimeForm === "string" && audioDropTimeForm !== "none") ? audioDropTimeForm : ""; // "" = not tested yet, "none" = no safe form found
var audioDropVideoTrackProven = (typeof audioDropVideoTrackProven === "boolean") ? audioDropVideoTrackProven : false; // requested video track number was seen to be honoured
var audioDropAudioTrackProven = (typeof audioDropAudioTrackProven === "boolean") ? audioDropAudioTrackProven : false; // same for the audio track number
if (audioDropTimeForm === "") {
    audioDropVideoTrackProven = false;
    audioDropAudioTrackProven = false;
}
var audioDropLog = [];

function adLog(text) {
    audioDropLog.push(String(text));
}

function makeTimeArg(form, seconds, timeObject) {
    if (form === "ticks") {
        return timeObject ? String(timeObject.ticks) : String(Math.round(seconds * AUDIODROP_TICKS_PER_SECOND));
    }
    if (form === "time") {
        if (timeObject) return timeObject;
        var t = new Time();
        t.seconds = seconds;
        return t;
    }
    if (form === "secondsString") return String(seconds);
    if (form === "secondsNumber") return seconds;
    return null;
}

function clipKey(kind, trackIndex, clip) {
    return kind + ":" + trackIndex + ":" + Math.round(clip.start.seconds * 1000);
}

function snapshotSequenceClips(seq) {
    var keys = {};
    var kinds = [["v", seq.videoTracks], ["a", seq.audioTracks]];
    for (var k = 0; k < kinds.length; k++) {
        var tracks = kinds[k][1];
        for (var ti = 0; ti < tracks.numTracks; ti++) {
            var track = tracks[ti];
            if (!track) continue;
            for (var ci = 0; ci < track.clips.numItems; ci++) {
                if (track.clips[ci]) keys[clipKey(kinds[k][0], ti, track.clips[ci])] = true;
            }
        }
    }
    return keys;
}

// Every clip, on any track, that was not there before.
function listNewClips(seq, before) {
    var added = [];
    var kinds = [["v", seq.videoTracks], ["a", seq.audioTracks]];
    for (var k = 0; k < kinds.length; k++) {
        var tracks = kinds[k][1];
        for (var ti = 0; ti < tracks.numTracks; ti++) {
            var track = tracks[ti];
            if (!track) continue;
            for (var ci = 0; ci < track.clips.numItems; ci++) {
                var clip = track.clips[ci];
                if (clip && !before[clipKey(kinds[k][0], ti, clip)]) {
                    added.push({ kind: kinds[k][0], trackIndex: ti, clip: clip, start: clip.start.seconds });
                }
            }
        }
    }
    return added;
}

function trackCounts(seq) {
    var counts = { v: [], a: [] };
    var i;
    for (i = 0; i < seq.videoTracks.numTracks; i++) counts.v.push(seq.videoTracks[i].clips.numItems);
    for (i = 0; i < seq.audioTracks.numTracks; i++) counts.a.push(seq.audioTracks[i].clips.numItems);
    return counts;
}

// Which tracks gained or lost clips, for the log line of a stray drop.
function describeTrackChanges(before, after) {
    var parts = [];
    var i;
    var was;
    if (before.v.length !== after.v.length) parts.push("V treklar " + before.v.length + "->" + after.v.length);
    if (before.a.length !== after.a.length) parts.push("A treklar " + before.a.length + "->" + after.a.length);
    for (i = 0; i < after.v.length; i++) {
        was = i < before.v.length ? before.v[i] : 0;
        if (was !== after.v[i]) parts.push("V" + (i + 1) + " " + was + "->" + after.v[i]);
    }
    for (i = 0; i < after.a.length; i++) {
        was = i < before.a.length ? before.a[i] : 0;
        if (was !== after.a[i]) parts.push("A" + (i + 1) + " " + was + "->" + after.a[i]);
    }
    return parts.join(", ");
}

// True when a track other than the two requested ones gained or lost a clip.
function otherTracksChanged(before, after, videoTrackIndex, audioTrackIndex) {
    var i;
    if (before.v.length !== after.v.length || before.a.length !== after.a.length) return true;
    for (i = 0; i < before.v.length; i++) {
        if (i !== videoTrackIndex && before.v[i] !== after.v[i]) return true;
    }
    for (i = 0; i < before.a.length; i++) {
        if (i !== audioTrackIndex && before.a[i] !== after.a[i]) return true;
    }
    return false;
}

function snapshotTrack(kind, track, trackIndex, keys) {
    if (!track) return;
    for (var ci = 0; ci < track.clips.numItems; ci++) {
        if (track.clips[ci]) keys[clipKey(kind, trackIndex, track.clips[ci])] = true;
    }
}

function listNewOnTrack(kind, track, trackIndex, before, added) {
    if (!track) return;
    for (var ci = 0; ci < track.clips.numItems; ci++) {
        var clip = track.clips[ci];
        if (clip && !before[clipKey(kind, trackIndex, clip)]) {
            added.push({ kind: kind, trackIndex: trackIndex, clip: clip, start: clip.start.seconds });
        }
    }
}

function describeClips(added) {
    var parts = [];
    for (var i = 0; i < added.length; i++) {
        parts.push((added[i].kind === "v" ? "V" : "A") + (added[i].trackIndex + 1) + "@" + (Math.round(added[i].start * 100) / 100));
    }
    return parts.length ? parts.join(",") : "hech narsa";
}

// True when every new clip starts at the wanted time on the wanted track.
function landedAsRequested(added, seconds, videoTrackIndex, audioTrackIndex) {
    if (added.length === 0) return false;
    for (var i = 0; i < added.length; i++) {
        if (Math.abs(added[i].start - seconds) > 0.1) return false;
        if (added[i].kind === "v" && added[i].trackIndex !== videoTrackIndex) return false;
        if (added[i].kind === "a" && added[i].trackIndex !== audioTrackIndex) return false;
    }
    return true;
}

function hasAudioClip(added) {
    for (var i = 0; i < added.length; i++) {
        if (added[i].kind === "a") return true;
    }
    return false;
}

function removeClips(added) {
    var failed = 0;
    for (var i = added.length - 1; i >= 0; i--) {
        try {
            added[i].clip.remove(false, false);
        } catch (removeError) {
            failed++;
            adLog("remove xato: " + removeError.toString());
        }
    }
    return failed === 0;
}

function sequenceContentEnd(seq) {
    var end = 0;
    var kinds = [seq.videoTracks, seq.audioTracks];
    for (var k = 0; k < kinds.length; k++) {
        for (var ti = 0; ti < kinds[k].numTracks; ti++) {
            var track = kinds[k][ti];
            if (!track) continue;
            for (var ci = 0; ci < track.clips.numItems; ci++) {
                if (track.clips[ci] && track.clips[ci].end.seconds > end) end = track.clips[ci].end.seconds;
            }
        }
    }
    return end;
}

// Finds the time form this Premiere really honours, using a temporary sequence
// so the editor's own timeline is never touched by the trials.
function calibrateTimeForm(projectItem, originalSeq) {
    var found = "none";
    var scratch = null;
    if (typeof app.project.createNewSequenceFromClips !== "function") {
        adLog("kalibrovka: createNewSequenceFromClips yo'q");
        return found;
    }
    try {
        scratch = app.project.createNewSequenceFromClips("DROP+ test", [projectItem]);
        if (!scratch || scratch === 0) {
            adLog("kalibrovka: test sekvensiya yaratilmadi");
            return found;
        }
        try { app.project.openSequence(scratch.sequenceID); } catch (openScratchError) { }
        if (scratch.videoTracks.numTracks < 2) adLog("test: video trek qo'shish -> " + (addSequenceTrack(scratch, true) || "ok"));
        if (scratch.audioTracks.numTracks < 2) adLog("test: audio trek qo'shish -> " + (addSequenceTrack(scratch, false) || "ok"));

        var videoIndex = scratch.videoTracks.numTracks - 1;
        var audioIndex = scratch.audioTracks.numTracks - 1;
        adLog("test sekvensiya: V=" + scratch.videoTracks.numTracks + " A=" + scratch.audioTracks.numTracks);
        // With a single track the "requested track" check proves nothing; that
        // part is then checked later, past the end of the real timeline.

        var length = getInsertRangeEnd(projectItem, 0);
        if (length > 36000) length = 60;
        var forms = ["ticks", "time", "secondsString", "secondsNumber"];
        for (var f = 0; f < forms.length; f++) {
            var testTime = Math.round(sequenceContentEnd(scratch)) + 7;
            var before = snapshotSequenceClips(scratch);
            try {
                scratch.overwriteClip(projectItem, makeTimeArg(forms[f], testTime, null), videoIndex, audioIndex);
            } catch (formError) {
                adLog(forms[f] + ": xato " + formError.toString());
                continue;
            }
            var added = listNewClips(scratch, before);
            var ok = landedAsRequested(added, testTime, videoIndex, audioIndex);
            adLog(forms[f] + ": so'raldi V" + (videoIndex + 1) + "/A" + (audioIndex + 1) + "@" + testTime + " -> " + describeClips(added) + (ok ? " OK" : ""));
            if (ok) {
                found = forms[f];
                audioDropVideoTrackProven = videoIndex >= 1;
                audioDropAudioTrackProven = audioIndex >= 1 && hasAudioClip(added);
                break;
            }
        }
    } catch (calibrateError) {
        adLog("kalibrovka xato: " + calibrateError.toString());
        found = "none";
    }

    // Clean up: remove the test sequence and bring the editor's timeline back.
    if (scratch && scratch !== 0) {
        try {
            app.project.deleteSequence(scratch);
        } catch (deleteError) {
            adLog("test sekvensiya o'chirilmadi: " + deleteError.toString());
        }
    }
    try { app.project.openSequence(originalSeq.sequenceID); } catch (reopenError) { adLog("timeline qayta ochilmadi: " + reopenError.toString()); }
    return found;
}

// Places the clip (video + linked audio) at the playhead and confirms the
// result. Returns "" on success, otherwise the reason.
function placeLinkedClipAtPlayhead(seq, projectItem, playheadTime, videoTrackIndex, audioTrackIndex, hasAudio) {
    if (audioDropTimeForm === "") {
        audioDropTimeForm = calibrateTimeForm(projectItem, seq);
        adLog("tanlangan usul: " + audioDropTimeForm);
    }
    if (audioDropTimeForm === "none") {
        return "Premiere'ning bu versiyasida xavfsiz joylashtirish usuli aniqlanmadi";
    }
    var active = app.project.activeSequence;
    if (!active || active.sequenceID !== seq.sequenceID) {
        return "faol Timeline o'zgarib qoldi";
    }

    if (!audioDropVideoTrackProven || (hasAudio && !audioDropAudioTrackProven)) {
        // The time form is proven, the track numbers are not yet. Try once past
        // the end of everything on the timeline, where no track holds any media,
        // so whichever track Premiere picks, nothing can be overwritten.
        var probeTime = Math.round(sequenceContentEnd(seq)) + 10;
        var probeBefore = snapshotSequenceClips(seq);
        try {
            seq.overwriteClip(projectItem, makeTimeArg(audioDropTimeForm, probeTime, null), videoTrackIndex, audioTrackIndex);
        } catch (probeError) {
            adLog("trek sinovi xato: " + probeError.toString());
            return "Premiere klipni qo'ymadi";
        }
        var probeAdded = listNewClips(seq, probeBefore);
        var probeOk = landedAsRequested(probeAdded, probeTime, videoTrackIndex, audioTrackIndex);
        adLog("trek sinovi: so'raldi V" + (videoTrackIndex + 1) + "/A" + (audioTrackIndex + 1) + "@" + probeTime + " -> " + describeClips(probeAdded) + (probeOk ? " OK" : ""));
        var probeRemoved = removeClips(probeAdded);
        if (!probeOk || !probeRemoved) {
            audioDropTimeForm = "none";
            if (!probeRemoved) return "sinov klipi Timeline oxirida qolib ketdi (uni o'chiring yoki Ctrl+Z bosing)";
            return "Premiere so'ralgan trekka qo'ymayapti";
        }
        audioDropVideoTrackProven = true;
        if (hasAudioClip(probeAdded)) audioDropAudioTrackProven = true;
    }

    // Reading every clip of a long timeline is slow, so only the two requested
    // tracks are read in full; for all the others a clip count is enough to see
    // that nothing landed on them.
    var target = playheadTime.seconds;
    var videoTrack = seq.videoTracks[videoTrackIndex];
    var audioTrack = seq.audioTracks[audioTrackIndex];
    var before = {};
    snapshotTrack("v", videoTrack, videoTrackIndex, before);
    snapshotTrack("a", audioTrack, audioTrackIndex, before);
    var countsBefore = trackCounts(seq);
    try {
        seq.overwriteClip(projectItem, makeTimeArg(audioDropTimeForm, target, playheadTime), videoTrackIndex, audioTrackIndex);
    } catch (placeError) {
        adLog("joylash xato: " + placeError.toString());
        return "Premiere klipni qo'ymadi";
    }
    var added = [];
    listNewOnTrack("v", videoTrack, videoTrackIndex, before, added);
    listNewOnTrack("a", audioTrack, audioTrackIndex, before, added);
    var countsAfter = trackCounts(seq);
    var strayed = otherTracksChanged(countsBefore, countsAfter, videoTrackIndex, audioTrackIndex);
    adLog("joylash: so'raldi V" + (videoTrackIndex + 1) + "/A" + (audioTrackIndex + 1) + "@" + (Math.round(target * 100) / 100) + " -> " + describeClips(added) + (strayed ? " + boshqa trek o'zgardi [" + describeTrackChanges(countsBefore, countsAfter) + "]" : ""));
    if (!strayed && landedAsRequested(added, target, videoTrackIndex, audioTrackIndex)) return "";

    // Not where it was asked for: take it back and stop using the timeline
    // for the rest of this session rather than risk another wrong drop.
    var removed = removeClips(added);
    audioDropTimeForm = "none";
    if (strayed) return "klip so'ralmagan trekka tushdi, Ctrl+Z bosib qaytaring";
    return "klip noto'g'ri joyga tushdi" + (removed ? " va qaytarib olindi" : ", uni qaytarib bo'lmadi (Ctrl+Z bosing)");
}

// Returns the first free track directly after the rows that are in use at the
// playhead (V2 busy -> V3, A2 busy -> A3). With nothing at the playhead it is
// the first track. Returns numTracks when a new track has to be added.
function findNearestFreeTrackIndex(trackCollection, startSeconds, endSeconds, alsoFreeAtStartLength) {
    var trackCount = trackCollection.numTracks;
    var trackIndex;
    var lowestBusyIndex = -1;
    for (trackIndex = 0; trackIndex < trackCount; trackIndex++) {
        if (!isTrackFreeInRange(trackCollection[trackIndex], startSeconds, endSeconds)) {
            lowestBusyIndex = trackIndex;
            break;
        }
    }
    for (trackIndex = lowestBusyIndex + 1; trackIndex < trackCount; trackIndex++) {
        if (!isTrackFreeInRange(trackCollection[trackIndex], startSeconds, endSeconds)) continue;
        if (alsoFreeAtStartLength > 0 && !isTrackFreeInRange(trackCollection[trackIndex], 0, alsoFreeAtStartLength)) continue;
        return trackIndex;
    }
    return trackCount;
}

// The supported ExtendScript DOM cannot create sequence tracks, so Premiere's
// QE DOM is used. Returns "" on success or the reason it failed.
function addSequenceTrack(seq, isVideo) {
    var collection = isVideo ? seq.videoTracks : seq.audioTracks;
    var before = collection.numTracks;
    try {
        if (typeof app.enableQE === "function") app.enableQE();
        if (typeof qe === "undefined" || !qe.project || !qe.project.getActiveSequence) {
            throw new Error("QE sequence API mavjud emas");
        }
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq || typeof qeSeq.addTracks !== "function") {
            throw new Error("QE addTracks API mavjud emas");
        }
        if (isVideo) {
            qeSeq.addTracks(1, before - 1, 0);
        } else {
            qeSeq.addTracks(0, 0, 1, 1, before - 1);
            // Some Premiere builds accept only the full seven-argument form.
            if (seq.audioTracks.numTracks === before) {
                qeSeq.addTracks(0, 0, 1, 1, before - 1, 0, 0);
            }
        }
    } catch (trackAddError) {
        return trackAddError.toString();
    }
    collection = isVideo ? seq.videoTracks : seq.audioTracks;
    return collection.numTracks > before ? "" : "Premiere yangi trek qo'shmadi";
}

// Import a downloaded video and place its linked video/audio at the playhead.
// Only empty tracks are used, so existing timeline clips are never overwritten.
function importAndInsertVideoToTimeline(filePath) {
    audioDropLog = [];
    var timeStart = new Date().getTime();
    var timeImported = timeStart;
    var timeTracks = timeStart;
    try {
        if (!app.project) {
            return JSON.stringify({ success: false, message: "Premiere Pro'da loyiha ochilmagan." });
        }

        var fileObj = new File(filePath);
        if (!fileObj.exists) {
            return JSON.stringify({ success: false, message: "Video fayl topilmadi: " + filePath });
        }

        var videoBin = getOrCreateBin("DROP+ Video");
        var projectItem = findItemByMediaPath(videoBin, fileObj.fsName);
        if (!projectItem) {
            app.project.importFiles([fileObj.fsName], true, videoBin, false);
            projectItem = findItemByMediaPath(videoBin, fileObj.fsName);
            if (!projectItem) projectItem = findItemByMediaPath(app.project.rootItem, fileObj.fsName);
        }
        if (!projectItem) {
            return JSON.stringify({ success: false, message: "Video Project paneliga import qilindi, ammo ProjectItem topilmadi." });
        }

        var seq = app.project.activeSequence;
        if (!seq) {
            if (typeof app.project.createNewSequenceFromClips !== "function") {
                return JSON.stringify({
                    success: false,
                    inserted: false,
                    message: "Faol Timeline yo'q va Premiere yangi Timeline yaratish API'sini bermadi. Video Project paneliga import qilindi."
                });
            }
            var newSequenceName = "DROP+ - " + (projectItem.name || "Video");
            var newSequence = app.project.createNewSequenceFromClips(newSequenceName, [projectItem]);
            if (!newSequence || newSequence === 0) {
                return JSON.stringify({
                    success: false,
                    inserted: false,
                    message: "Video import qilindi, ammo yangi Timeline yaratilmagan."
                });
            }
            if (newSequence.sequenceID) {
                try { app.project.openSequence(newSequence.sequenceID); } catch (openSequenceError) { }
            }
            return JSON.stringify({
                success: true,
                inserted: true,
                sequenceName: newSequence.name || newSequenceName,
                message: "Faol Timeline yo'q edi. Yangi '" + (newSequence.name || newSequenceName) + "' Timeline yaratildi va video boshidan qo'shildi."
            });
        }

        // Use the nearest free rows right next to the ones being edited at the
        // playhead; add a new track only when every existing one is occupied.
        timeImported = new Date().getTime();
        var playheadTime = seq.getPlayerPosition();
        var rangeStart = playheadTime.seconds;
        var rangeEnd = getInsertRangeEnd(projectItem, rangeStart);
        var qeError = "";
        var safeStartLength = 0;

        var videoTrackIndex = findNearestFreeTrackIndex(seq.videoTracks, rangeStart, rangeEnd, safeStartLength);
        if (videoTrackIndex >= seq.videoTracks.numTracks) {
            qeError = addSequenceTrack(seq, true);
            videoTrackIndex = findNearestFreeTrackIndex(seq.videoTracks, rangeStart, rangeEnd, safeStartLength);
        }
        var audioTrackIndex = findNearestFreeTrackIndex(seq.audioTracks, rangeStart, rangeEnd, safeStartLength);
        if (audioTrackIndex >= seq.audioTracks.numTracks) {
            var audioAddError = addSequenceTrack(seq, false);
            if (audioAddError) qeError = qeError ? qeError + "; " + audioAddError : audioAddError;
            audioTrackIndex = findNearestFreeTrackIndex(seq.audioTracks, rangeStart, rangeEnd, safeStartLength);
        }

        if (videoTrackIndex >= seq.videoTracks.numTracks || audioTrackIndex >= seq.audioTracks.numTracks ||
            !isTrackFreeInRange(seq.videoTracks[videoTrackIndex], rangeStart, rangeEnd) ||
            !isTrackFreeInRange(seq.audioTracks[audioTrackIndex], rangeStart, rangeEnd)) {
            return JSON.stringify({
                success: false,
                inserted: false,
                message: "Video loyihaga import qilindi, ammo bo'sh trek yo'q va yangi trek qo'shilmadi. Mavjud kliplar o'zgartirilmadi." + (qeError ? " Sabab: " + qeError : "")
            });
        }

        // Both destinations are verified free for this range, so this cannot replace
        // any existing timeline media. The result is checked: the clip must start
        // at the playhead, otherwise it is taken back off the timeline.
        timeTracks = new Date().getTime();
        var placeProblem = placeLinkedClipAtPlayhead(seq, projectItem, playheadTime, videoTrackIndex, audioTrackIndex, true);
        adLog("vaqt: import=" + (timeImported - timeStart) + "ms trek=" + (timeTracks - timeImported) + "ms joylash=" + (new Date().getTime() - timeTracks) + "ms");
        if (placeProblem) {
            return JSON.stringify({
                success: false,
                inserted: false,
                diag: audioDropLog.join(" | "),
                message: "Video Project paneliga (DROP+ Video) import qilindi, lekin Timeline'ga qo'yilmadi: " + placeProblem + ". Mavjud kliplarga tegilmadi."
            });
        }

        return JSON.stringify({
            success: true,
            inserted: true,
            videoTrack: "V" + (videoTrackIndex + 1),
            audioTrack: "A" + (audioTrackIndex + 1),
            seconds: playheadTime.seconds,
            diag: audioDropLog.join(" | "),
            message: "Video va audiosi Timeline'ga qo'shildi (V" + (videoTrackIndex + 1) + ", A" + (audioTrackIndex + 1) + ")."
        });
    } catch (err) {
        return JSON.stringify({ success: false, diag: audioDropLog.join(" | "), message: "Premiere ExtendScript xatoligi: " + err.toString() });
    }
}

// Import a still image and place it on the nearest free video track at the
// playhead. Uses the same verified placement as videos; a still has no audio,
// so only a video track is taken.
function importAndInsertImageToTimeline(filePath) {
    audioDropLog = [];
    var timeStart = new Date().getTime();
    var timeImported = timeStart;
    var timeTracks = timeStart;
    try {
        if (!app.project) {
            return JSON.stringify({ success: false, message: "Premiere Pro'da loyiha ochilmagan." });
        }
        var fileObj = new File(filePath);
        if (!fileObj.exists) {
            return JSON.stringify({ success: false, message: "Rasm fayli topilmadi: " + filePath });
        }

        var imageBin = getOrCreateBin("DROP+ Rasm");
        var projectItem = findItemByMediaPath(imageBin, fileObj.fsName);
        if (!projectItem) {
            app.project.importFiles([fileObj.fsName], true, imageBin, false);
            projectItem = findItemByMediaPath(imageBin, fileObj.fsName);
            if (!projectItem) projectItem = findItemByMediaPath(app.project.rootItem, fileObj.fsName);
        }
        if (!projectItem) {
            return JSON.stringify({ success: false, message: "Rasm import qilindi, ammo Project panelida topilmadi." });
        }
        // Large photos are fitted to the frame instead of showing only a corner.
        try { if (typeof projectItem.setScaleToFrameSize === "function") projectItem.setScaleToFrameSize(); } catch (scaleError) { }

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({
                success: true,
                inserted: false,
                message: "Rasm 'DROP+ Rasm' papkasiga qo'shildi. Faol Timeline yo'q, shuning uchun Timeline'ga qo'yilmadi."
            });
        }

        timeImported = new Date().getTime();
        var playheadTime = seq.getPlayerPosition();
        var rangeStart = playheadTime.seconds;
        var rangeEnd = getInsertRangeEnd(projectItem, rangeStart);
        var qeError = "";
        var videoTrackIndex = findNearestFreeTrackIndex(seq.videoTracks, rangeStart, rangeEnd, 0);
        if (videoTrackIndex >= seq.videoTracks.numTracks) {
            qeError = addSequenceTrack(seq, true);
            videoTrackIndex = findNearestFreeTrackIndex(seq.videoTracks, rangeStart, rangeEnd, 0);
        }
        if (videoTrackIndex >= seq.videoTracks.numTracks ||
            !isTrackFreeInRange(seq.videoTracks[videoTrackIndex], rangeStart, rangeEnd)) {
            return JSON.stringify({
                success: false,
                inserted: false,
                diag: audioDropLog.join(" | "),
                message: "Rasm loyihaga import qilindi, ammo bo'sh video trek yo'q va yangi trek qo'shilmadi. Mavjud kliplar o'zgartirilmadi." + (qeError ? " Sabab: " + qeError : "")
            });
        }

        timeTracks = new Date().getTime();
        var placeProblem = placeLinkedClipAtPlayhead(seq, projectItem, playheadTime, videoTrackIndex, 0, false);
        adLog("vaqt: import=" + (timeImported - timeStart) + "ms trek=" + (timeTracks - timeImported) + "ms joylash=" + (new Date().getTime() - timeTracks) + "ms");
        if (placeProblem) {
            return JSON.stringify({
                success: false,
                inserted: false,
                diag: audioDropLog.join(" | "),
                message: "Rasm Project paneliga (DROP+ Rasm) import qilindi, lekin Timeline'ga qo'yilmadi: " + placeProblem + ". Mavjud kliplarga tegilmadi."
            });
        }
        return JSON.stringify({
            success: true,
            inserted: true,
            videoTrack: "V" + (videoTrackIndex + 1),
            seconds: playheadTime.seconds,
            diag: audioDropLog.join(" | "),
            message: "Rasm Timeline'ga qo'shildi (V" + (videoTrackIndex + 1) + ")."
        });
    } catch (err) {
        return JSON.stringify({ success: false, diag: audioDropLog.join(" | "), message: "Premiere ExtendScript xatoligi: " + err.toString() });
    }
}

// ---------------------------------------------------------------------------
// After Effects. The panel calls the same function names in every host; here
// they are replaced with versions that add a layer to the open composition at
// the current time. Nothing below runs in Premiere Pro.
// ---------------------------------------------------------------------------
var dropHostIsAfterEffects = false;
try {
    dropHostIsAfterEffects = (typeof BridgeTalk !== "undefined" && BridgeTalk.appName === "aftereffects");
} catch (hostCheckError) { }

function dropAeFindFolder(folderName) {
    var proj = app.project;
    for (var i = 1; i <= proj.numItems; i++) {
        var it = proj.item(i);
        if (it instanceof FolderItem && it.name === folderName && it.parentFolder === proj.rootFolder) return it;
    }
    return proj.items.addFolder(folderName);
}

function dropAeFindFootage(fileObject) {
    var proj = app.project;
    for (var i = 1; i <= proj.numItems; i++) {
        var it = proj.item(i);
        try {
            if (it instanceof FootageItem && it.file && it.file.fsName === fileObject.fsName) return it;
        } catch (e) { }
    }
    return null;
}

function dropAeInsert(filePath, folderName, label, fitToComp) {
    var undoOpen = false;
    try {
        if (!app.project) {
            return JSON.stringify({ success: false, message: "After Effects'da loyiha ochilmagan." });
        }
        var fileObject = new File(filePath);
        if (!fileObject.exists) {
            return JSON.stringify({ success: false, message: "Fayl diskda topilmadi: " + filePath });
        }

        app.beginUndoGroup("DROP+");
        undoOpen = true;

        var comp = app.project.activeItem;
        var item = dropAeFindFootage(fileObject);
        if (!item) {
            item = app.project.importFile(new ImportOptions(fileObject));
            try { item.parentFolder = dropAeFindFolder(folderName); } catch (folderError) { }
        }

        if (!(comp instanceof CompItem)) {
            app.endUndoGroup();
            return JSON.stringify({
                success: false,
                message: label + " Project paneliga qo'shildi. Ochiq kompozitsiya yo'q, shuning uchun Timeline'ga qo'yilmadi."
            });
        }

        var layer = comp.layers.add(item);
        layer.startTime = comp.time;
        if (fitToComp && item.width && item.height && (item.width > comp.width || item.height > comp.height)) {
            var fit = Math.min(comp.width / item.width, comp.height / item.height) * 100;
            try { layer.property("Scale").setValue([fit, fit]); } catch (scaleError) { }
        }

        app.endUndoGroup();
        return JSON.stringify({
            success: true,
            diag: "after effects: " + comp.name + " @" + comp.time,
            message: label + " kompozitsiyaga qo'shildi: " + comp.name
        });
    } catch (err) {
        if (undoOpen) { try { app.endUndoGroup(); } catch (undoError) { } }
        return JSON.stringify({ success: false, message: "After Effects xatoligi: " + err.toString() });
    }
}

if (dropHostIsAfterEffects) {
    testPremiereConnection = function () {
        try {
            if (!app.project) {
                return JSON.stringify({ success: false, message: "Loyiha (Project) ochilmagan" });
            }
            var projectName = "Nomsiz loyiha";
            try { if (app.project.file) projectName = decodeURI(app.project.file.name); } catch (nameError) { }
            var comp = app.project.activeItem;
            var hasComp = (comp instanceof CompItem);
            return JSON.stringify({
                success: true,
                projectName: projectName,
                hasActiveSequence: hasComp,
                sequenceName: hasComp ? comp.name : "Kompozitsiya yo'q"
            });
        } catch (e) {
            return JSON.stringify({ success: false, message: e.toString() });
        }
    };
    importAndInsertToTimeline = function (filePath) {
        return dropAeInsert(filePath, "DROP+ Musiqa", "Musiqa", false);
    };
    importAndInsertVideoToTimeline = function (filePath) {
        return dropAeInsert(filePath, "DROP+ Video", "Video", false);
    };
    importAndInsertImageToTimeline = function (filePath) {
        return dropAeInsert(filePath, "DROP+ Rasm", "Rasm", true);
    };
}
