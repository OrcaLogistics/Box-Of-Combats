/**
 * Box of Combats — Electron Main Process
 * Always-on-top overlay, NO transparency (solid opaque background)
 */

const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let isHidden = false;

// Persona storage path (next to executable)
const PERSONA_FILE = path.join(__dirname, 'personas.json');

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    x: Math.floor((screenWidth - 900) / 2),
    y: Math.floor((screenHeight - 700) / 2),

    // Overlay settings — NO transparency
    alwaysOnTop: true,
    frame: false,
    transparent: false,
    resizable: true,
    skipTaskbar: false,

    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },

    backgroundColor: '#1a1a1a',
    hasShadow: true
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.on('blur', () => {
    if (!isHidden && mainWindow) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  });
}

function toggleVisibility() {
  if (!mainWindow) return;
  if (isHidden) {
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    isHidden = false;
  } else {
    mainWindow.hide();
    isHidden = true;
  }
}

// IPC
ipcMain.handle('close-app', () => app.quit());
ipcMain.handle('minimize-app', () => { if (mainWindow) mainWindow.minimize(); });

ipcMain.handle('load-personas', () => {
  try {
    if (fs.existsSync(PERSONA_FILE)) {
      return JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf-8'));
    }
  } catch (e) { console.error('Failed to load personas:', e); }
  return { personas: [], activeIndex: -1 };
});

ipcMain.handle('save-personas', (event, data) => {
  try {
    fs.writeFileSync(PERSONA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) { console.error('Failed to save personas:', e); return false; }
});

// Single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (isHidden) { mainWindow.show(); isHidden = false; }
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    globalShortcut.register('CommandOrControl+Shift+C', toggleVisibility);
  });
}

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
