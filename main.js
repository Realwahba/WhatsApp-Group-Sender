const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');

let mainWindow;
let client;
let nextSendTime = null;
let scheduledJobs = new Map();

// Constants
const activityLogPath = path.join(process.cwd(), 'activity_log.json');
const indexFilePath = path.resolve('image_index.json');
const scheduleConfigPath = path.join(process.cwd(), 'schedule_config.json');

// Schedule configuration
let scheduleConfig = {
    type: 'interval',
    intervalHours: 24,
    dailyTimes: [],
    customSchedule: {
        0: [], // Sunday
        1: [], // Monday
        2: [], // Tuesday
        3: [], // Wednesday
        4: [], // Thursday
        5: [], // Friday
        6: []  // Saturday
    },
    active: false
};

// Helper Functions
function sendToRenderer(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}

function logError(error, context = '') {
    try {
        const logFile = path.join(process.cwd(), 'logs', 'error.log');
        const timestamp = new Date().toISOString();
        const logEntry = `${timestamp} - ${context}: ${error.message}\n${error.stack}\n\n`;
        fs.appendFileSync(logFile, logEntry);
    } catch (err) {
        console.error('Error writing to log file:', err);
    }
}

// Activity Management
function initializeActivityLog() {
    try {
        if (!fs.existsSync(activityLogPath)) {
            fs.writeFileSync(activityLogPath, JSON.stringify({
                activities: [],
                remainingImages: 0
            }, null, 2));
        }
    } catch (error) {
        logError(error, 'initializeActivityLog');
    }
}

function logActivity(activity) {
    try {
        let logData = { activities: [], remainingImages: 0 };
        
        if (fs.existsSync(activityLogPath)) {
            const fileContent = fs.readFileSync(activityLogPath, 'utf8');
            logData = JSON.parse(fileContent);
        }

        // Calculate remaining images
        const imageDir = path.join(process.cwd(), 'images');
        const currentIndex = getCurrentIndex();
        const remainingImages = fs.readdirSync(imageDir)
            .filter(file => file.toLowerCase().endsWith('.jpg')).length - currentIndex;

        // Add new activity to the beginning of the array
        logData.activities.unshift({
            ...activity,
            timestamp: new Date().toISOString()
        });

        // Keep only last 50 activities
        logData.activities = logData.activities.slice(0, 50);
        logData.remainingImages = remainingImages;

        // Write updated data back to file
        fs.writeFileSync(activityLogPath, JSON.stringify(logData, null, 2));

        // Send update to renderer
        sendToRenderer('activity-update', logData.activities);

    } catch (error) {
        console.error('Error logging activity:', error);
        logError(error, 'logActivity');
    }
}

// Index Management
function getCurrentIndex() {
    try {
        if (fs.existsSync(indexFilePath)) {
            const data = fs.readFileSync(indexFilePath, 'utf8');
            return JSON.parse(data).index || 0;
        }
        return 0;
    } catch (error) {
        logError(error, 'getCurrentIndex');
        return 0;
    }
}

function saveCurrentIndex(index) {
    try {
        fs.writeFileSync(indexFilePath, JSON.stringify({ index }));
    } catch (error) {
        logError(error, 'saveCurrentIndex');
        throw error;
    }
}

// Directory Management
function ensureDirectories() {
    const dirs = [
        path.join(process.cwd(), 'images'),
        path.join(process.cwd(), '.wwebjs_auth'),
        path.join(process.cwd(), 'logs')
    ];

    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// Window Management
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        icon: path.join(__dirname, 'icon.ico')
    });

    mainWindow.loadFile('index.html');

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// WhatsApp Client Management
async function initializeWhatsApp() {
    try {
        client = new Client({
            authStrategy: new LocalAuth({
                clientId: 'my_custom_session',
                dataPath: path.join(process.cwd(), '.wwebjs_auth')
            }),
            puppeteer: {
                headless: true,
                defaultViewport: null,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--allow-running-insecure-content',
                    '--disable-features=IsolateOrigins,site-per-process'
                ],
                ignoreDefaultArgs: ['--disable-extensions'],
                executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
            },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        });

        client.on('qr', async (qr) => {
            try {
                const dataURL = await qrcode.toDataURL(qr);
                sendToRenderer('qr-code', dataURL);
            } catch (err) {
                console.error('QR Code generation error:', err);
                sendToRenderer('error', 'Failed to generate QR code');
            }
        });

        client.on('ready', () => {
            sendToRenderer('whatsapp-ready');
            console.log('WhatsApp client is ready!');
            fetchGroups();
        });

        client.on('disconnected', async (reason) => {
            console.log('Client disconnected:', reason);
            sendToRenderer('disconnected', reason);
            try {
                await client.initialize();
            } catch (error) {
                console.error('Failed to reconnect:', error);
            }
        });

        await client.initialize();

    } catch (error) {
        console.error('Failed to initialize WhatsApp client:', error);
        sendToRenderer('error', 'Failed to initialize WhatsApp');
        throw error;
    }
}
// Group Management
async function fetchGroups() {
    try {
        const chats = await client.getChats();
        const groups = chats
            .filter(chat => chat.id._serialized.endsWith('@g.us'))
            .map(group => ({
                id: group.id._serialized,
                name: group.name
            }));

        sendToRenderer('groups-loaded', groups);
    } catch (error) {
        console.error('Error fetching groups:', error);
        sendToRenderer('error', 'Failed to fetch WhatsApp groups');
    }
}

// Message Sending Functions
function validateGroupId(groupId) {
    if (!groupId || typeof groupId !== 'string') {
        throw new Error('Group ID is required');
    }
    if (!groupId.endsWith('@g.us')) {
        throw new Error('Invalid group ID format. Must end with @g.us');
    }
    return true;
}

async function sendMessage(groupId, message) {
    try {
        await client.sendMessage(groupId, message);
        console.log(`Message sent to group ${groupId}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return true;
    } catch (error) {
        console.error(`Failed to send message to group ${groupId}:`, error);
        return false;
    }
}

async function sendMediaToGroup(groupId, media, delay = 2000) {
    try {
        await client.sendMessage(groupId, media);
        await new Promise(resolve => setTimeout(resolve, delay));
        return true;
    } catch (error) {
        console.error(`Failed to send media to group ${groupId}:`, error);
        return false;
    }
}

async function sendToGroups(groupIds, message, includeImages = true, imageCount = 4) {
    try {
        const groups = Array.isArray(groupIds) ? groupIds : [groupIds];
        groups.forEach(groupId => validateGroupId(groupId));

        let successfulGroups = 0;
        let currentIndex = getCurrentIndex();
        let imagesToSend = [];

        if (includeImages) {
            const imageDir = path.join(process.cwd(), 'images');
            const imageFiles = fs.readdirSync(imageDir)
                .filter(file => file.toLowerCase().endsWith('.jpg'))
                .sort((a, b) => {
                    const numA = parseInt(a.match(/\d+/) || [0]);
                    const numB = parseInt(b.match(/\d+/) || [0]);
                    return numA - numB;
                });

            imagesToSend = imageFiles.slice(currentIndex, currentIndex + imageCount);

            if (imagesToSend.length === 0 && includeImages) {
                sendToRenderer('send-error', 'No images available to send');
                return;
            }
        }

        for (const groupId of groups) {
            let groupSuccess = true;
            const chat = await client.getChatById(groupId);
            const groupName = chat.name;

            try {
                if (message && message.trim()) {
                    const messageSent = await sendMessage(groupId, message.trim());
                    if (!messageSent) {
                        console.warn(`Failed to send message to group ${groupId}`);
                        groupSuccess = false;
                    }
                }

                if (includeImages) {
                    for (const imageFile of imagesToSend) {
                        const imagePath = path.join(process.cwd(), 'images', imageFile);
                        if (!fs.existsSync(imagePath)) {
                            console.error(`Image not found: ${imagePath}`);
                            groupSuccess = false;
                            continue;
                        }

                        const media = MessageMedia.fromFilePath(imagePath);
                        const sent = await sendMediaToGroup(groupId, media);
                        if (!sent) {
                            groupSuccess = false;
                        }
                    }
                }

                if (groupSuccess) {
                    successfulGroups++;
                }

                logActivity({
                    groupName,
                    imageCount: includeImages ? imagesToSend.length : 0,
                    message: !!message.trim(),
                    success: groupSuccess
                });

            } catch (error) {
                logError(error, `sendToGroups - ${groupId}`);
                groupSuccess = false;
                
                logActivity({
                    groupName,
                    imageCount: 0,
                    message: !!message.trim(),
                    success: false
                });
            }
        }

        if (successfulGroups > 0 && includeImages) {
            currentIndex += imagesToSend.length;
            saveCurrentIndex(currentIndex);
        }

        sendToRenderer('send-complete', {
            sentCount: includeImages ? imagesToSend.length : 0,
            nextIndex: currentIndex,
            messageSent: !!message.trim(),
            groupCount: successfulGroups,
            totalGroups: groups.length,
            messageOnly: !includeImages
        });

    } catch (error) {
        logError(error, 'sendToGroups');
        console.error('Error in sendToGroups:', error);
        sendToRenderer('send-error', error.message);
        throw error;
    }
}

// Schedule Management Functions
function clearAllScheduledJobs() {
    scheduledJobs.forEach(job => clearTimeout(job));
    scheduledJobs.clear();
}

function getNextScheduledTime(config) {
    const now = new Date();
    
    switch(config.type) {
        case 'interval':
            return new Date(now.getTime() + config.intervalHours * 60 * 60 * 1000);
            
        case 'daily':
            let nextTime = null;
            for (const timeStr of config.dailyTimes) {
                const [hours, minutes] = timeStr.split(':').map(Number);
                const scheduledTime = new Date(now);
                scheduledTime.setHours(hours, minutes, 0, 0);
                
                if (scheduledTime <= now) {
                    scheduledTime.setDate(scheduledTime.getDate() + 1);
                }
                
                if (!nextTime || scheduledTime < nextTime) {
                    nextTime = scheduledTime;
                }
            }
            return nextTime;
            
        case 'custom':
            let nextCustomTime = null;
            const currentDay = now.getDay();
            
            for (let i = 0; i < 7; i++) {
                const checkDay = (currentDay + i) % 7;
                const dayTimes = config.customSchedule[checkDay];
                
                for (const timeStr of dayTimes) {
                    const [hours, minutes] = timeStr.split(':').map(Number);
                    const scheduledTime = new Date(now);
                    scheduledTime.setDate(now.getDate() + i);
                    scheduledTime.setHours(hours, minutes, 0, 0);
                    
                    if (scheduledTime > now && (!nextCustomTime || scheduledTime < nextCustomTime)) {
                        nextCustomTime = scheduledTime;
                    }
                }
            }
            return nextCustomTime;
            
        default:
            throw new Error('Invalid schedule type');
    }
}
async function scheduleNextRun(groupIds, message, imageCount) {
    if (!scheduleConfig.active) return;
    
    const nextTime = getNextScheduledTime(scheduleConfig);
    if (!nextTime) {
        console.error('No valid schedule times configured');
        sendToRenderer('schedule-error', 'No valid schedule times configured');
        return;
    }
    
    const timeUntilNext = nextTime.getTime() - Date.now();
    const jobId = setTimeout(async () => {
        try {
            await sendToGroups(groupIds, message, true, imageCount);
            scheduledJobs.delete(jobId);
            scheduleNextRun(groupIds, message, imageCount);
        } catch (error) {
            console.error('Scheduled send failed:', error);
            sendToRenderer('send-error', error.message);
        }
    }, timeUntilNext);
    
    scheduledJobs.set(jobId, jobId);
    sendToRenderer('next-send-time', nextTime.getTime());
    updateCountdown(nextTime);
}

function updateCountdown(targetTime) {
    if (!targetTime) return;

    const interval = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            clearInterval(interval);
            return;
        }

        const now = new Date();
        const timeDiff = targetTime - now;

        if (timeDiff <= 0) {
            clearInterval(interval);
            return;
        }

        const hours = Math.floor(timeDiff / (1000 * 60 * 60));
        const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeDiff % (1000 * 60)) / 1000);

        sendToRenderer('countdown-update', { hours, minutes, seconds });
    }, 1000);
}

function startCustomSchedule(config, groupIds, message, imageCount) {
    try {
        stopSchedule(); // Clear existing schedule
        scheduleConfig = { ...config, active: true };
        scheduleNextRun(groupIds, message, imageCount);
        saveScheduleConfig();
        
        sendToRenderer('schedule-started', {
            groupCount: groupIds.length,
            scheduleType: config.type
        });
        
    } catch (error) {
        logError(error, 'startCustomSchedule');
        console.error('Error starting custom schedule:', error);
        sendToRenderer('error', error.message);
        throw error;
    }
}

function stopSchedule() {
    clearAllScheduledJobs();
    scheduleConfig.active = false;
    saveScheduleConfig();
    sendToRenderer('schedule-stopped');
}

// Config Persistence
function saveScheduleConfig() {
    try {
        fs.writeFileSync(scheduleConfigPath, JSON.stringify(scheduleConfig, null, 2));
    } catch (error) {
        logError(error, 'saveScheduleConfig');
    }
}

function loadScheduleConfig() {
    try {
        if (fs.existsSync(scheduleConfigPath)) {
            const data = fs.readFileSync(scheduleConfigPath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        logError(error, 'loadScheduleConfig');
    }
    return null;
}

// Application Event Handlers
app.whenReady().then(async () => {
    try {
        ensureDirectories();
        createWindow();
        await initializeWhatsApp();
        initializeActivityLog();
        
        const savedConfig = loadScheduleConfig();
        if (savedConfig && savedConfig.active) {
            scheduleConfig = savedConfig;
        }

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    } catch (error) {
        logError(error, 'app.whenReady');
        console.error('Error during app initialization:', error);
        dialog.showErrorBox('Initialization Error', 
            'Failed to initialize the application. Check the logs for details.');
    }
});

app.on('window-all-closed', () => {
    stopSchedule();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC Handlers
ipcMain.on('send-message', async (event, { groupIds, message }) => {
    try {
        if (!client) {
            throw new Error('WhatsApp client not initialized');
        }
        await sendToGroups(groupIds, message, false);
    } catch (error) {
        logError(error, 'ipcMain.send-message');
        console.error('Error sending message:', error);
        sendToRenderer('send-error', error.message);
    }
});

ipcMain.on('send-images', async (event, { groupIds, message, imageCount = 4 }) => {
    try {
        if (!client) {
            throw new Error('WhatsApp client not initialized');
        }
        await sendToGroups(groupIds, message, true, imageCount);
    } catch (error) {
        logError(error, 'ipcMain.send-images');
        console.error('Error sending images:', error);
        sendToRenderer('send-error', error.message);
    }
});

ipcMain.on('start-custom-schedule', (event, { scheduleConfig: newConfig, groupIds, message, imageCount }) => {
    try {
        if (!client) {
            throw new Error('WhatsApp client not initialized');
        }
        startCustomSchedule(newConfig, groupIds, message, imageCount);
    } catch (error) {
        logError(error, 'ipcMain.start-custom-schedule');
        console.error('Error starting custom schedule:', error);
        sendToRenderer('error', error.message);
    }
});

ipcMain.on('stop-schedule', () => {
    try {
        stopSchedule();
    } catch (error) {
        logError(error, 'ipcMain.stop-schedule');
        console.error('Error stopping schedule:', error);
        sendToRenderer('error', error.message);
    }
});

ipcMain.handle('get-image-queue', async () => {
    try {
        const imageDir = path.join(process.cwd(), 'images');
        const currentIndex = getCurrentIndex();
        const imageFiles = fs.readdirSync(imageDir)
            .filter(file => file.toLowerCase().endsWith('.jpg'))
            .sort((a, b) => {
                const numA = parseInt(a.match(/\d+/) || [0]);
                const numB = parseInt(b.match(/\d+/) || [0]);
                return numA - numB;
            })
            .slice(currentIndex, currentIndex + 4)
            .map(filename => path.join(imageDir, filename).replace(/\\/g, '/'));
        
        return imageFiles;
    } catch (error) {
        logError(error, 'get-image-queue');
        console.error('Error getting image queue:', error);
        return [];
    }
});

ipcMain.on('refresh-groups', async () => {
    try {
        await fetchGroups();
    } catch (error) {
        console.error('Error refreshing groups:', error);
        sendToRenderer('error', 'Failed to refresh groups');
    }
});