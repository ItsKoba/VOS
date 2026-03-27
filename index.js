import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    getContentType
} from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import fs from "fs";
import readline from "readline";
import chalk from "chalk";

// Konfigurasi Logger kustom menggunakan Chalk (ESM Version)
const logger = {
    info: (msg) => console.log(`${chalk.blue.bold('[INFO]')} ${msg}`),
    success: (msg) => console.log(`${chalk.green.bold('[SUCCESS]')} ${msg}`),
    warn: (msg) => console.log(`${chalk.yellow.bold('[WARN]')} ${msg}`),
    error: (msg) => console.log(`${chalk.red.bold('[ERROR]')} ${msg}`),
    bot: (msg) => console.log(`${chalk.magenta.bold('[BOT]')} ${msg}`)
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

/**
 * Fungsi rekursif untuk membongkar pesan WhatsApp.
 * Menangani berbagai versi protokol pembungkus View Once.
 */
const getRealMessage = (m) => {
    if (!m) return null;
    const wrappers = [
        'viewOnceMessageV2',
        'viewOnceMessageV2Extension',
        'viewOnceMessage',
        'viewOnceMessageV3',
        'ephemeralMessage',
        'documentWithCaptionMessage',
        'message'
    ];

    for (const key of wrappers) {
        if (m[key]) {
            const sub = m[key].message || m[key];
            return getRealMessage(sub);
        }
    }
    return m;
};

async function startBot() {
    // Inisialisasi folder
    if (!fs.existsSync('./storage')) fs.mkdirSync('./storage');
    if (!fs.existsSync('./sessions')) fs.mkdirSync('./sessions');

    const { state, saveCreds } = await useMultiFileAuthState('sessions');
    const { version } = await fetchLatestBaileysVersion();

    // Inisialisasi Socket Baileys
    const sock = (makeWASocket.default || makeWASocket)({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        // Mencegah bot mengirim status online secara otomatis saat connect
        markOnline: false,
        // Menonaktifkan sinkronisasi histori agar lebih ringan dan stealth
        shouldSyncHistoryMessage: () => false
    });

    // Login via Pairing Code
    if (!sock.authState.creds.registered) {
        logger.warn("Perangkat belum terhubung.");
        const phoneNumber = await question(chalk.cyan('Masukkan nomor WhatsApp (62xxx): '));
        const code = await sock.requestPairingCode(phoneNumber.trim());
        console.log(`\n${chalk.white.bgMagenta.bold(' KODE PAIRING: ')} ${chalk.bold.yellow(code)}\n`);
        logger.info("Masukkan kode tersebut di menu Perangkat Tertaut.");
    }

    // Monitoring Koneksi
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const code = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
            logger.error(`Terputus (Code: ${code}). Mencoba menyambung ulang...`);
            if (code !== DisconnectReason.loggedOut) startBot();
        } else if (connection === 'open') {
            logger.success(`Terhubung ke WhatsApp v${version}`);

            // PAKSA STATUS MENJADI OFFLINE (Unavailable)
            // Ini akan memastikan status 'Online' hilang segera setelah terhubung
            await sock.sendPresenceUpdate('unavailable');

            logger.bot("Mode Senyap & Anti-Online Aktif.");
            logger.info("Balas pesan View Once untuk menyimpan secara otomatis.");
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Monitoring Pesan
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        const sender = m.key.remoteJid;

        // Deteksi Quoted Message (Pesan yang dibalas)
        const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;

        // Log sederhana aktivitas trafik
        if (!m.key.fromMe) {
            process.stdout.write(chalk.gray(`[LOG] Traffic from ${sender.split('@')[0]}\r`));
        }

        if (quoted) {
            const realQuoted = getRealMessage(quoted);
            const type = getContentType(realQuoted);

            // Verifikasi apakah yang dibalas adalah media View Once
            const isViewOnce = quoted.viewOnceMessage ||
                quoted.viewOnceMessageV2 ||
                quoted.viewOnceMessageV2Extension ||
                quoted.viewOnceMessageV3 ||
                realQuoted?.[type]?.viewOnce === true;

            if (isViewOnce && (type === 'imageMessage' || type === 'videoMessage')) {
                logger.bot(`Mendeteksi reply ke View Once dari ${chalk.yellow(sender)}`);

                try {
                    // Download media dari metadata quoted
                    const buffer = await downloadMediaMessage(
                        { message: quoted },
                        'buffer',
                        {},
                        {
                            logger: pino({ level: 'silent' }),
                            reuploadRequest: sock.updateMediaMessage
                        }
                    );

                    const ext = type === 'imageMessage' ? 'jpg' : 'mp4';
                    const filename = `./storage/VO_${Date.now()}.${ext}`;

                    fs.writeFileSync(filename, buffer);
                    logger.success(`Media tersimpan secara diam-diam: ${chalk.cyan(filename)}`);

                } catch (err) {
                    logger.error(`Gagal menyimpan media: ${err.message}`);
                }
            }
        }
    });
}

// Jalankan Bot
startBot().catch(err => logger.error(`Fatal Error: ${err.message}`));
