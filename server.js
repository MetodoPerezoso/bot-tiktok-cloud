const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { TikTokLiveConnection } = require('tiktok-live-connector');
const gTTS = require('gtts');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

const dirTemp = path.join(__dirname, 'public', 'temp');
if (!fs.existsSync(dirTemp)) {
    fs.mkdirSync(dirTemp, { recursive: true });
}

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

let licenciasValidas = {};
const sesionesActivasPorLicencia = {};

// Memoria global para el Ranking de Actividad (Likes)
let rankingLikes = {};

// Diccionario de conversión de emojis de TikTok [tag] a palabras habladas
const mapaEmojisTikTok = {
    'laughcry': 'jaja',
    'joy': 'jaja',
    'smile': 'sonrisa',
    'heart': 'corazón',
    'love': 'me encanta',
    'rose': 'rosa',
    'fire': 'fuego',
    'clap': 'aplausos',
    'cry': 'carita llorando',
    'wink': 'guiño',
    'surprised': 'sorpresa',
    'thinking': 'pensativo',
    'thumbsup': 'me gusta',
    'cool': 'genial'
};

function cargarLicencias() {
    try {
        const filePath = path.join(__dirname, 'licenses.json');
        if (!fs.existsSync(filePath)) {
            const defaultLicenses = { 
                "MP-PEREZOSO-PROMO1": { "activa": true, "expiracion": "2026-12-31" },
                "RODRI-ADMIN-2026": { "activa": true, "expiracion": null }
            };
            fs.writeFileSync(filePath, JSON.stringify(defaultLicenses, null, 2));
            licenciasValidas = defaultLicenses;
        } else {
            const data = fs.readFileSync(filePath, 'utf8');
            licenciasValidas = JSON.parse(data);
        }
    } catch (e) {
        console.error("❌ Error leyendo licenses.json:", e);
    }
}

cargarLicencias();

// Ruta para el widget de OBS (Browser Source)
app.get('/widget-likes', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'widget-likes.html'));
});

// Endpoint para reiniciar ranking desde el panel
app.post('/api/reset-likes', (req, res) => {
    rankingLikes = {};
    io.emit('actualizar-ranking-likes', []);
    res.json({ success: true });
});

function limpiarTexto(texto, permitirEmojis = false) {
    if (!texto) return '';

    if (permitirEmojis) {
        let textoProcesado = texto.replace(/\[([a-zA-Z0-9_]+)\]/g, (match, tag) => {
            const tagMin = tag.toLowerCase();
            return mapaEmojisTikTok[tagMin] ? ` ${mapaEmojisTikTok[tagMin]} ` : '';
        });
        return textoProcesado.trim();
    }

    let textoSinTags = texto.replace(/\[[a-zA-Z0-9_]+\]/g, '');
    return textoSinTags.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
}

function contienePalabraProhibida(texto, listaProhibidas) {
    if (!listaProhibidas || listaProhibidas.length === 0 || !texto) return false;
    const textoMin = texto.toLowerCase();
    return listaProhibidas.some(palabra => {
        const pLimpia = palabra.trim().toLowerCase();
        return pLimpia.length > 0 && textoMin.includes(pLimpia);
    });
}

function guardarAudioBase64(base64Data) {
    if (!base64Data) return null;
    try {
        const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) return null;

        const buffer = Buffer.from(matches[2], 'base64');
        const nombreArchivo = `custom_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
        const rutaArchivo = path.join(dirTemp, nombreArchivo);

        fs.writeFileSync(rutaArchivo, buffer);
        return `/temp/${nombreArchivo}`;
    } catch (e) {
        console.error("❌ Error al guardar archivo de audio personalizado:", e);
        return null;
    }
}

io.on('connection', (socket) => {
    console.log(`🟢 Un cliente se ha conectado: ${socket.id}`);

    let tiktokLiveConnection = null;
    let configuracionCliente = null;
    let claveLicenciaAsociada = null;

    socket.on('validar-licencia', (data) => {
        const key = data.key ? data.key.trim() : '';
        cargarLicencias();

        const licencia = licenciasValidas[key];

        if (licencia && licencia.activa) {
            let expiracionTexto = "Licencia Ilimitada (Vitalicia)";
            if (licencia.expiracion) {
                const fechaActual = new Date();
                const fechaExpiracion = new Date(licencia.expiracion + 'T23:59:59');

                if (fechaActual > fechaExpiracion) {
                    console.log(`❌ Intento de acceso con licencia vencida: ${key}`);
                    socket.emit('respuesta-licencia', { valida: false, mensaje: "Tu clave de acceso ha expirado." });
                    return;
                }
                expiracionTexto = `Válida hasta: ${licencia.expiracion}`;
            }

            claveLicenciaAsociada = key;

            const socketAnteriorId = sesionesActivasPorLicencia[key];
            if (socketAnteriorId && socketAnteriorId !== socket.id) {
                console.log(`⚠️ Licencia ${key} duplicada. Expulsando socket anterior: ${socketAnteriorId}`);
                io.to(socketAnteriorId).emit('sesion-expulsada', { 
                    mensaje: "Tu clave de acceso fue abierta en otro dispositivo." 
                });
            }

            sesionesActivasPorLicencia[key] = socket.id;

            console.log(`🔑 Licencia válida aceptada: ${key} para socket ${socket.id}`);
            socket.emit('respuesta-licencia', { 
                valida: true, 
                key: key, 
                expiracion: expiracionTexto 
            });
        } else {
            console.log(`❌ Intento de acceso con clave inválida: ${key}`);
            socket.emit('respuesta-licencia', { valida: false, mensaje: "Clave incorrecta o inactiva." });
        }
    });

    socket.on('probar-alerta', (data) => {
        let textoAlerta = '';
        let mensajeVisual = '';
        let customSoundUrl = null;
        const idiomaVoz = data.idioma || 'es';

        if (data.customSound) {
            customSoundUrl = guardarAudioBase64(data.customSound);
        }

        if (data.tipo === 'follow') {
            textoAlerta = "Gracias por seguirnos, Espectador de Prueba";
            mensajeVisual = "¡Espectador de Prueba comenzó a seguir el directo! 🎉 (Prueba)";
        } else if (data.tipo === 'gift') {
            textoAlerta = "Espectador de Prueba envió 5 Rosas";
            mensajeVisual = "🎁 ¡Espectador de Prueba envió 5x Rosas (50 diamantes)! (Prueba)";
        }

        if (textoAlerta) {
            generarYEnviarAudio(socket, textoAlerta, "ALERTA PRUEBA", mensajeVisual, true, customSoundUrl, idiomaVoz);
        }
    });

    socket.on('reproducir-efecto-rapido', (data) => {
        if (data.customSound) {
            let customSoundUrl = guardarAudioBase64(data.customSound);
            socket.emit('reproducir-audio', {
                soundUrl: customSoundUrl,
                audioUrl: null,
                usuario: "SOUNDBOARD",
                mensaje: "⚡ Efecto de sonido rápido activado",
                esAlerta: true
            });
        }
    });

    socket.on('desconectar-bot', () => {
        if (tiktokLiveConnection) {
            try { 
                tiktokLiveConnection.disconnect(); 
                console.log("🔌 Bot desconectado manualmente por el usuario.");
            } catch (e) {}
        }
        tiktokLiveConnection = null;
        socket.emit('estado-conexion', { status: 'desconectado' });
    });

    socket.on('configurar-usuario', (config) => {
        if (!config.licenseKey || !licenciasValidas[config.licenseKey]) {
            socket.emit('estado-conexion', { status: 'error', message: 'Licencia no autorizada.' });
            return;
        }

        if (sesionesActivasPorLicencia[config.licenseKey] !== socket.id) {
            socket.emit('estado-conexion', { status: 'error', message: 'Sesión duplicada o invalidada.' });
            return;
        }

        configuracionCliente = config;
        const username = config.username;
        const leerNombre = config.leerNombre;
        const leerEmojis = config.leerEmojis || false;
        const rolesConfig = config.roles || { todos: true, seguidores: false, moderadores: false, suscriptores: false };
        const tipoComentario = config.tipoComentario || 'todos';
        const textoComando = config.textoComando || '!tts';
        const palabrasProhibidas = config.palabrasProhibidas || [];
        const idiomaVoz = config.idiomaVoz || 'es';

        console.log(`📡 Conectando a ${username} con licencia ${config.licenseKey} (Idioma: ${idiomaVoz}, Leer Emojis: ${leerEmojis})`);
        
        if (tiktokLiveConnection) {
            try { tiktokLiveConnection.disconnect(); } catch (e) {}
        }

        tiktokLiveConnection = new TikTokLiveConnection(username, {});
        let tiempoDeInicio = Date.now();

        let intentosReconexion = 0;
        const maxIntentos = 5;

        function conectarConReintento() {
            tiktokLiveConnection.connect().then(state => {
                console.log(`✅ Conectado a la sala de ${username} (Room ID: ${state.roomId})`);
                socket.emit('estado-conexion', { status: 'conectado', room: state.roomId });
                intentosReconexion = 0;
            }).catch(err => {
                console.error(`❌ Error al conectar con ${username} (Intento ${intentosReconexion + 1}/${maxIntentos}):`, err.message);
                
                if (intentosReconexion < maxIntentos) {
                    intentosReconexion++;
                    let tiempoEspera = Math.min(10000 * Math.pow(2, intentosReconexion - 1), 60000);
                    
                    console.log(`⏳ Reintentando conexión en ${tiempoEspera / 1000} segundos...`);
                    socket.emit('estado-conexion', { status: 'error', message: `Protección anti-bloqueo. Reintentando en ${tiempoEspera / 1000}s...` });

                    setTimeout(() => {
                        conectarConReintento();
                    }, tiempoEspera);
                } else {
                    socket.emit('estado-conexion', { status: 'error', message: 'Límite de reintentos alcanzado. Posible bloqueo temporal.' });
                }
            });
        }

        conectarConReintento();

        tiktokLiveConnection.on('like', data => {
            const usernameLike = limpiarTexto(data.user ? data.user.nickname : 'Anonimo', leerEmojis);
            const count = data.likeCount || 1;

            if (!rankingLikes[usernameLike]) {
                rankingLikes[usernameLike] = 0;
            }
            rankingLikes[usernameLike] += count;

            const topLikes = Object.entries(rankingLikes)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([user, likes]) => ({ user, likes }));

            io.emit('actualizar-ranking-likes', topLikes);
        });

        tiktokLiveConnection.on('chat', data => {
            const tiempoMensaje = parseInt(data.common.createTime);
            if (tiempoMensaje < tiempoDeInicio) return;

            const mensajeLimpio = limpiarTexto(data.content, leerEmojis);
            const nombreLimpio = limpiarTexto(data.user.nickname, leerEmojis);

            if (mensajeLimpio === '') return;

            if (contienePalabraProhibida(mensajeLimpio, palabrasProhibidas)) {
                console.log(`🚫 Mensaje de ${nombreLimpio} omitido por palabra prohibida.`);
                return;
            }

            const esSeguidor = data.followInfo && data.followInfo.following === true;
            const esModerator = data.isModerator === true;
            const esSubscriptor = data.user.userBadges && data.user.userBadges.some(b => b.url && b.url.includes('sub'));

            if (!rolesConfig.todos) {
                let autorizado = false;
                if (rolesConfig.seguidores && esSeguidor) autorizado = true;
                if (rolesConfig.moderadores && esModerator) autorizado = true;
                if (rolesConfig.suscriptores && esSubscriptor) autorizado = true;

                if (!autorizado) return;
            }

            if (tipoComentario === 'punto' && !mensajeLimpio.startsWith('.')) return;
            if (tipoComentario === 'barra' && !mensajeLimpio.startsWith('/')) return;
            if (tipoComentario === 'comando' && !mensajeLimpio.startsWith(textoComando)) return;

            let textoALeer = leerNombre ? `${nombreLimpio} dice ${mensajeLimpio}` : mensajeLimpio;

            generarYEnviarAudio(socket, textoALeer, nombreLimpio, mensajeLimpio, false, null, idiomaVoz);
        });

        tiktokLiveConnection.on('social', data => {
            const alertas = configuracionCliente ? configuracionCliente.alertas : { follow: true };
            if (!alertas.follow) return;

            const nombreLimpio = limpiarTexto(data.user.nickname, leerEmojis);
            const esSeguir = data.displayType && data.displayType.includes('follow');

            if (esSeguir || data.actionId === 3) {
                const textoAlerta = `Gracias por seguirnos, ${nombreLimpio}`;
                const mensajeVisual = `¡${nombreLimpio} comenzó a seguir el directo! 🎉`;
                let customSoundUrl = guardarAudioBase64(alertas.soundFollow);

                generarYEnviarAudio(socket, textoAlerta, "ALERTA TIKTOK", mensajeVisual, true, customSoundUrl, idiomaVoz);
            }
        });

        tiktokLiveConnection.on('gift', data => {
            const alertas = configuracionCliente ? configuracionCliente.alertas : { gift: true };
            if (!alertas.gift) return;

            if (data.giftType === 1 && !data.repeatEnd) {
                return;
            }

            const nombreLimpio = limpiarTexto(data.user.nickname, leerEmojis);
            const nombreRegalo = data.giftName || (data.gift && data.gift.name) || 'un regalo';
            const cantidad = data.repeatCount || 1;
            const diamantesPerUnit = (data.diamondCount !== undefined) ? data.diamondCount : ((data.gift && data.gift.diamondCount) || 0);
            const diamantes = diamantesPerUnit * cantidad;

            const textoAlerta = `${nombreLimpio} envió ${cantidad} ${nombreRegalo}`;
            const mensajeVisual = `🎁 ¡${nombreLimpio} envió ${cantidad}x ${nombreRegalo} (${diamantes} diamantes)!`;
            let customSoundUrl = guardarAudioBase64(alertas.soundGift);

            generarYEnviarAudio(socket, textoAlerta, "REGALO", mensajeVisual, true, customSoundUrl, idiomaVoz);
        });
    });

    socket.on('disconnect', () => {
        if (tiktokLiveConnection) {
            try { tiktokLiveConnection.disconnect(); } catch (e) {}
        }
        if (claveLicenciaAsociada && sesionesActivasPorLicencia[claveLicenciaAsociada] === socket.id) {
            delete sesionesActivasPorLicencia[claveLicenciaAsociada];
        }
        console.log(`🔴 Cliente desconectado: ${socket.id}`);
    });
});

function generarYEnviarAudio(socket, textoALeer, usuario, mensajeVisual, esAlerta, customSoundUrl, idiomaVoz) {
    console.log(`🔊 [TTS - ${idiomaVoz}] ${textoALeer}`);

    const nombreArchivo = `tts_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
    const rutaArchivo = path.join(dirTemp, nombreArchivo);

    const speech = new gTTS(textoALeer, idiomaVoz || 'es');
    speech.save(rutaArchivo, (err) => {
        if (err) {
            console.error("❌ Error al generar gTTS:", err);
            return;
        }

        socket.emit('reproducir-audio', {
            soundUrl: customSoundUrl,
            audioUrl: `/temp/${nombreArchivo}`,
            usuario: usuario,
            mensaje: mensajeVisual,
            esAlerta: esAlerta
        });

        setTimeout(() => {
            try {
                if (fs.existsSync(rutaArchivo)) fs.unlinkSync(rutaArchivo);
            } catch (e) {}
        }, 15000);
    });
}

const RENDER_URL = 'https://bot-tiktok-cloud.onrender.com';

setInterval(() => {
    https.get(RENDER_URL, (res) => {
        console.log(`⏰ [Keep-Alive] Ping enviado. Código: ${res.statusCode}`);
    }).on('error', (err) => {
        console.error(`❌ [Keep-Alive] Error en el ping:`, err.message);
    });
}, 300000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor SaaS corriendo en http://localhost:${PORT}`);
});