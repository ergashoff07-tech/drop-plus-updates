// DROP+ for DaVinci Resolve Studio - Electron main process.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 440,
        height: 780,
        minWidth: 340,
        minHeight: 420,
        useContentSize: true,
        title: 'DROP+',
        backgroundColor: '#0b0b10',
        alwaysOnTop: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            // The panel downloads and converts media with Node, so it needs Node in the page.
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.setMenu(null);
    mainWindow.on('close', function () { app.quit(); });
    mainWindow.loadFile('index.html');
}

// Native save / open dialogs for the page (it asks synchronously).
ipcMain.on('drop-dialog', function (event, request) {
    try {
        const filters = (request.fileTypes && request.fileTypes.length)
            ? [{ name: request.fileTypes.join(', ').toUpperCase(), extensions: request.fileTypes }]
            : [];
        if (request.type === 'save') {
            const chosen = dialog.showSaveDialogSync(mainWindow, {
                title: request.title || 'DROP+',
                defaultPath: request.initialPath ? path.join(request.initialPath, request.defaultName || '') : (request.defaultName || undefined),
                filters: filters
            });
            event.returnValue = { err: 0, data: chosen || '' };
        } else {
            const picked = dialog.showOpenDialogSync(mainWindow, {
                title: request.title || 'DROP+',
                defaultPath: request.initialPath || undefined,
                properties: [request.chooseDirectory ? 'openDirectory' : 'openFile'].concat(request.allowMultiple ? ['multiSelections'] : []),
                filters: request.chooseDirectory ? [] : filters
            });
            event.returnValue = { err: 0, data: picked || [] };
        }
    } catch (error) {
        event.returnValue = { err: 1, data: request.type === 'save' ? '' : [], message: String(error) };
    }
});

app.on('ready', createWindow);
app.on('window-all-closed', function () { app.quit(); });
