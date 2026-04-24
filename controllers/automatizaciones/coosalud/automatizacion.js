import dotenv from "dotenv";
import { Hyperbrowser } from "@hyperbrowser/sdk";
import { chromium } from "playwright-core";
import { guardarResultadoEnCache, obtenerResultadoDeCache } from '../../../utils/memoryCache.js';
import { envioSolicitudCita } from '../../../config/twilio.js';
import { leerExcel } from '../../../utils/excel/leerExcel.js'
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let browser, page, session;
let contextGlobal;
let pageMozartia;

const client = new Hyperbrowser({
  apiKey: process.env.HYPERBROWSER_API_KEY,
});

//PQRS COOSALUD
const detectarSesionExpiradaCoosalud = async (page) => {
  try {
    // Esperar un poco a que la página termine de estabilizarse
    await page.waitForLoadState('domcontentloaded');

    const urlActual = page.url();

    // 1️⃣ Si la URL es la de login → sesión expirada
    if (urlActual.includes('/auth/login')) {
      return true;
    }

    // 2️⃣ Si existe el botón de login "Funcionarios Coosalud"
    const botonLogin = page.locator('a.button.button--auto', { 
      hasText: 'Funcionarios Coosalud' 
    });

    if (await botonLogin.count() > 0) {
      return true;
    }

    // 3️⃣ Si NO existe un elemento que solo aparece cuando hay sesión activa
    const elementoInterno = page.locator('#new_incident');

    if (await elementoInterno.count() === 0) {
      return true;
    }

    // ✅ Si nada de lo anterior ocurre, la sesión sigue activa
    return false;

  } catch (error) {
    console.log("Error verificando sesión, asumiendo expirada:", error.message);
    return true; // Ante cualquier error, forzamos renovación
  }
};

async function seleccionarSelectPorTexto(page, selector, texto) {
  const name = await page.getAttribute(selector, 'name');

  const contenedorVisual = page.locator(
    `.inputMultipleSelectorContainer[data-name="${name}"]`
  );

  await contenedorVisual.click();

  // 🔥 Buscar SOLO dentro del dropdown visible
  const dropdown = page.locator('#inputMultipleSelector');

  const opcion = dropdown.locator('.inputMultipleSelectOptionTitle', {
    hasText: texto
  });

  await opcion.first().waitFor({ state: 'visible', timeout: 10000 });
  await opcion.first().click();
}

async function seleccionarTreeSelectConBuscador(page, selector, texto) {
  const name = await page.getAttribute(selector, 'name');

  const contenedorVisual = page.locator(
    `.inputMultipleSelectorContainer[data-name="${name}"]`
  );

  await contenedorVisual.click();

  const dropdown = page.locator('#inputMultipleSelector');
  await dropdown.waitFor({ state: 'visible', timeout: 10000 });

  const inputBusqueda = dropdown.locator('input[placeholder="Buscar"]');
  await inputBusqueda.waitFor({ state: 'visible', timeout: 5000 });

  await inputBusqueda.click();
  await inputBusqueda.clear();
  await inputBusqueda.pressSequentially(texto, { delay: 100 });

  await page.waitForTimeout(1500);

  const todasOpciones = dropdown.locator('.inputMultipleSelectOptionTitle');
  const count = await todasOpciones.count();

  for (let i = 0; i < count; i++) {
    const op = todasOpciones.nth(i);
    const textoOpcion = (await op.textContent())?.trim();

    if (textoOpcion?.toUpperCase() === texto.trim().toUpperCase()) {
      await op.scrollIntoViewIfNeeded();
      await op.click();
      return;
    }
  }

  throw new Error(`No se encontró la opción "${texto}" en el selector ${selector}`);
}

async function seleccionarTipoSolicitud(page, selector, texto, textoPadre = null) {
  const name = await page.getAttribute(selector, 'name');

  const contenedorVisual = page.locator(
    `.inputMultipleSelectorContainer[data-name="${name}"]`
  );

  await contenedorVisual.click();

  const dropdown = page.locator('#inputMultipleSelector');
  await dropdown.waitFor({ state: 'visible', timeout: 10000 });

  const inputBusqueda = dropdown.locator('input[placeholder="Buscar"]');
  await inputBusqueda.waitFor({ state: 'visible', timeout: 5000 });

  await inputBusqueda.click();
  await inputBusqueda.fill('');
  await inputBusqueda.pressSequentially(texto, { delay: 80 });

  await page.waitForTimeout(1200);

  const opciones = dropdown.locator('.inputMultipleSelectOption');
  const count = await opciones.count();

  console.log(`Total opciones tipoSolicitud: ${count}`);

  let ultimoPadre = null;

  const textoBusqueda = (texto || "").toUpperCase().trim();

  for (let i = 0; i < count; i++) {
    const op = opciones.nth(i);

    const textoOpcion = (await op.locator('.inputMultipleSelectOptionTitle').textContent())?.trim();
    if (!textoOpcion) continue;

    const textoOpcionNorm = textoOpcion.toUpperCase().trim();

    const esPadre = await op.evaluate(el =>
      el.classList.contains('inputMultipleSelectOptionParent')
    );

    if (esPadre) {
      ultimoPadre = textoOpcion;
      console.log(`Padre: "${ultimoPadre}"`);
      continue;
    }

    console.log(`  Hijo: "${textoOpcion}" | Padre actual: "${ultimoPadre}"`);

    // 🔍 Detectar código si existe al inicio (ej: "1234 Algo")
    const matchCodigo = textoOpcion.match(/^\d+/)?.[0];

    const coincideCodigo =
      matchCodigo &&
      matchCodigo.toUpperCase() === textoBusqueda;

    const coincideTexto =
      textoOpcionNorm.includes(textoBusqueda);

    if (coincideCodigo || coincideTexto) {

      // filtro por padre si aplica
      if (textoPadre) {
        if (!ultimoPadre?.toUpperCase().includes(textoPadre.trim().toUpperCase())) {
          console.log(`  ⚠️ Descartado por padre: "${ultimoPadre}"`);
          continue;
        }
      }

      console.log(`✅ Seleccionando: "${textoOpcion}"`);
      await op.scrollIntoViewIfNeeded();
      await op.click();
      return;
    }
  }

  throw new Error(
    `No se encontró tipoSolicitud "${texto}"${textoPadre ? ` bajo "${textoPadre}"` : ''}`
  );
}

export const CrearPQRSCoosaludInicial = async (req, res) => {
  const { usuario, clave } = req.body
  try {
    // 1️⃣ Crear un perfil nuevo
    const profile = await client.profiles.create({
      name: `Coosalud-${usuario}`, // Nombre único por usuario
    });

    console.log("✅ Perfil creado:", profile.id);

    // 2️⃣ Crear sesión CON el perfil y persistChanges: true
    const session = await client.sessions.create({ 
      acceptCookies: true,
      profile: {
        id: profile.id,
        persistChanges: true, // 🔑 IMPORTANTE: Guarda el estado del navegador
      }
    });

    res.status(200).json({
      mensaje: "Proceso iniciado - Guardando perfil",
      liveUrl: session.liveUrl,
      profileId: profile.id, // 📌 Retorna el ID para guardarlo
    });

    console.log("preview:", session.liveUrl);

    (async () => {
      try {
        const browser = await chromium.connectOverCDP(session.wsEndpoint);
        const context = browser.contexts()[0];
        const page = context.pages()[0];

        await page.goto(
          "https://coosalud.sd.cloud.invgate.net/auth/login/type/servicedesk",
        );
        await page.waitForLoadState("networkidle");

        // LOGIN
        // Organización
        await page.locator('a.button.button--auto', { hasText: 'Funcionarios Coosalud' }).click();

        await page.fill('#i0116', usuario);
        await page.click('#idSIButton9');
        await page.waitForLoadState("networkidle");

        await page.waitForSelector('#i0118', { timeout: 15000 });
        await page.fill('#i0118', clave);
        await page.click('#idSIButton9');

        

      } catch (error) {
        console.error("Error en proceso asíncrono:", error);
      }
    })();
  } catch (error) {
    console.error("❌ Error al iniciar:", error.message);

    if (!res.headersSent) {
      res.status(500).json({
        mensaje: "Error al iniciar el proceso",
        error: error.message,
      });
    }
  }
}

export const CrearPQRSCoosalud = async (req, res) => {
  const { prioridad, riesgoVital, priorizado, regimen, sucursal, municipioResidencia, entidadSolicitud, codigoMotivo, tipoDocumento, idNumber, nombre, telefono, correo, asuntoCaso, descripcionCaso, tipoSolicitudGeneral } = req.body;
  const indice = descripcionCaso.indexOf('Usuario');
  const descripcionFinal = indice !== -1 ? descripcionCaso.substring(indice) : descripcionCaso;
  const asuntoLimpio = asuntoCaso.replace(/^Asunto:\s*/, '').trim();

  const tipoCanalRecepcion = "Canal";
  const canalRecepcion = "Línea";
  const profileId = process.env.profileIdCoosalud;
  const usuario = process.env.USUARIOCOOSALUDINVGATE
  const clave = process.env.CLAVECOOSALUDINVGATE
  const ipsInductora = "NO APLICA";

  let textoBusqueda = codigoMotivo;
  let textoPadreBusqueda = entidadSolicitud;
  if (tipoSolicitudGeneral && tipoSolicitudGeneral.trim() !== "") {
    textoBusqueda = tipoSolicitudGeneral;
    textoPadreBusqueda = null;
  } else {
    textoBusqueda = codigoMotivo;
  }

  let session;
  let browser;

  try {
    session = await client.sessions.create({ 
      acceptCookies: true,
      saveDownloads: true,
      profile: {
        id: profileId,
        persistChanges: false,
      }
    });

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    let context = browser.contexts()[0];
    let page = context.pages()[0];

    await page.goto(
      "https://coosalud.sd.cloud.invgate.net/auth/login/type/servicedesk",
      { waitUntil: 'networkidle' }
    );

    const sesionExpirada = await detectarSesionExpiradaCoosalud(page);

    if (sesionExpirada) {
      console.log("⚠️ Sesión expirada - Renovando perfil...");
      await browser.close();
      await client.sessions.stop(session.id);
      await new Promise(resolve => setTimeout(resolve, 2000));

      session = await client.sessions.create({ 
        acceptCookies: true,
        saveDownloads: true,
        profile: {
          id: profileId,
          persistChanges: true,
        }
      });

      browser = await chromium.connectOverCDP(session.wsEndpoint);
      context = browser.contexts()[0];
      page = context.pages()[0];
      
      await page.goto("https://coosalud.sd.cloud.invgate.net/auth/login/type/servicedesk");
      await page.fill('#login_username', usuario);
      await page.fill('#login_password', clave);
      await page.click('#button_login');

      await page.waitForLoadState('networkidle');
    }

    await page.waitForSelector('#new_incident', { timeout: 15000 });
    await page.click('#new_incident');

    await page.waitForSelector('[data-value="243"]');
    await page.click('[data-value="243"]');

    await page.waitForSelector('.createRequestButton[data-category="243"]');
    await page.click('.createRequestButton[data-category="243"]');

    await page.waitForSelector('.requestCreatePriority', { 
      state: 'visible',
      timeout: 20000
    });

    await seleccionarSelectPorTexto(page, '#form_create_priority', prioridad);
    await seleccionarSelectPorTexto(page, '#custom_field_44479', riesgoVital);
    await seleccionarSelectPorTexto(page, '#custom_field_44480', priorizado);
    await seleccionarSelectPorTexto(page, '#custom_field_44471', regimen);
    await seleccionarSelectPorTexto(page, '#custom_field_46454', sucursal);
    await seleccionarTreeSelectConBuscador(page, '#custom_field_46455', municipioResidencia);
    await seleccionarTipoSolicitud(
      page,
      '#custom_field_44469',
      textoBusqueda,
      textoPadreBusqueda
    );
    await seleccionarTipoSolicitud(page, '#custom_field_44752', canalRecepcion, tipoCanalRecepcion);
    await seleccionarSelectPorTexto(page, '#custom_field_46457', tipoDocumento);
    await page.fill('#custom_field_44464', idNumber);
    await page.fill('#custom_field_46453', nombre);
    await page.fill('#custom_field_44467', telefono);
    await page.fill('#custom_field_44468', correo);
    await seleccionarSelectPorTexto(page, '#custom_field_46464', ipsInductora);
    await page.fill('#form_create_subject', asuntoLimpio);
    
    await page.waitForSelector('iframe.cke_wysiwyg_frame', { timeout: 10000 });
    const frame = await (await page.waitForSelector('iframe.cke_wysiwyg_frame')).contentFrame();
    await frame.waitForSelector('body');
    await frame.fill('body', descripcionFinal);

    const botonEnviar = page.locator('#submit_button');
    await botonEnviar.waitFor({ state: 'visible' });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      botonEnviar.click()
    ]);

    await page.waitForSelector('.requestViewId');
    const requestId = await page.getAttribute('.requestViewId', 'data-id');
    console.log('ID de la solicitud:', requestId);

    // ✅ Responder con el radicado generado
    return res.status(200).json({
      idNumber,
      estado: "completado",
      radicado: requestId,
      motivo: `PQRS creado con el número radicado: ${requestId}`,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("❌ Error en proceso:", error);
    return res.status(500).json({
      idNumber,
      estado: "error",
      radicado: null,
      motivo: "Error al procesar la solicitud",
      error: error.message,
      timestamp: new Date().toISOString()
    });

  } finally {
    console.log("🔒 Cerrando sesión Hyperbrowser...");
    try {
      if (browser) await browser.close();
    } catch (e) {
      console.log("Error cerrando browser:", e.message);
    }
    try {
      if (session) await client.sessions.stop(session.id);
      console.log("✅ Sesión cerrada correctamente");
    } catch (e) {
      console.log("Error cerrando sesión:", e.message);
    }
  }
};


export const ConsultarRadicadoPQRS = async (req, res) => {
  // Ahora recibimos 'documento' desde el body en lugar de params
  const { idNumber } = req.body;

  if (!idNumber) {
    return res.status(400).json({ 
      estado: "error",
      mensaje: "Falta el parámetro 'documento'"
    });
  }

  try {
    const resultado = await obtenerResultadoDeCache(idNumber);

    if (!resultado) {
      return res.status(404).json({ 
        estado: "no_encontrado",
        mensaje: "No se encontró información para este documento"
      });
    }

    return res.status(200).json({
      estado: "encontrado",
      idNumber,
      resultado
    });

  } catch (err) {
    console.error("Error consultando autorización:", err);
    res.status(500).json({ 
      estado: "error",
      mensaje: "Error al consultar", 
      error: err.message 
    });
  }
};



//Enviar Correo
// Construye el mapa IPS -> correo desde el directorio
const PALABRAS_IGNORAR = new Set([
  'EMPRESA', 'SOCIAL', 'DEL', 'ESTADO', 'DE', 'LA', 'LOS', 'LAS',
  'Y', 'EN', 'EL', 'IPS', 'SAS', 'ESE', 'LTDA', 'SA', 'EU',
  'HOSPITAL', 'CLINICA', 'CENTRO', 'FUNDACION', 'INSTITUTO',
]);

const cargarDirectorio = () => {
  const dirPath = path.join(__dirname, '../../../data/DIRECTORIO_CORREO_BACK_DE_CITASV.xlsx');
  const rows = leerExcel(dirPath);

  const mapa = {};
  for (const row of rows) {
    const prestador = row['PRESTADOR']?.toString().trim().toUpperCase();
    const correo = row['CORREO']?.toString().trim();
    const contacto  = row['CONTACTO']?.toString().trim() || null;
    if (prestador) {
      mapa[prestador] = {
        correo:   (correo && correo.toUpperCase() !== 'N/A') ? correo : null,
        contacto: contacto,
      };
    }
  }
  return mapa;
};

const normalizarNombre = (nombre) => {
  return nombre
    .toString()
    .trim()
    .toUpperCase()
    .normalize('NFD')                        // descompone tildes
    .replace(/[\u0300-\u036f]/g, '')         // quita diacríticos
    .replace(/\bS\.A\.S\.?\b/g, '')
    .replace(/\bS\.A\.?\b/g, '')
    .replace(/\bLTDA\.?\b/g, '')
    .replace(/\bIPS\b/g, '')
    .replace(/\bE\.S\.E\.?\b/g, '')
    .replace(/[^A-Z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const extraerPalabrasClave = (nombre) => {
  return new Set(
    normalizarNombre(nombre)
      .split(' ')
      .filter(p => p.length > 3 && !PALABRAS_IGNORAR.has(p))
  );
};

// Búsqueda exacta primero, luego normalizada (quita puntuación/espacios extra)
// Ahora retorna { correo, contacto } en vez de solo el correo
export const buscarDatosIPS = (ipsAtencion, directorio) => {
  const key = ipsAtencion?.toString().trim().toUpperCase();
  if (!key) return null;

  // Las mismas 4 estrategias, pero ahora retornan el objeto completo
  if (directorio[key]) return directorio[key];

  const keyNorm = key.replace(/[^A-Z0-9]/g, '');
  const matchNorm = Object.keys(directorio).find(k =>
    k.replace(/[^A-Z0-9]/g, '') === keyNorm
  );
  if (matchNorm) return directorio[matchNorm];

  const keyClean = normalizarNombre(key);
  const matchClean = Object.keys(directorio).find(k =>
    normalizarNombre(k) === keyClean
  );
  if (matchClean) return directorio[matchClean];

  // Estrategia 4 - cobertura de palabras clave
  const palabrasCita = extraerPalabrasClave(key);
  let mejorMatch = null;
  let mejorScore = 0;
  const UMBRAL = 0.75;

  for (const k of Object.keys(directorio)) {
    const palabrasDir = extraerPalabrasClave(k);
    if (!palabrasDir.size) continue;
    const score = [...palabrasDir].filter(p => palabrasCita.has(p)).length / palabrasDir.size;
    if (score > mejorScore) { mejorScore = score; mejorMatch = k; }
  }

  if (mejorScore >= UMBRAL) return directorio[mejorMatch];
  return null;
};

export const enviarCorreosDesdeExcel = async (req, res) => {
  try {
    const { citas } = req.body;

    if (!Array.isArray(citas) || citas.length === 0) {
      return res.status(400).json({ error: 'Se requiere un array "citas" en el body' });
    }

    const directorio = cargarDirectorio();
    const resultados = [];

    for (const cita of citas) {
      const ipsAtencion = cita['Nombre de la IPS de atención'];
      const datosIPS    = buscarDatosIPS(ipsAtencion, directorio);

      if (!datosIPS) {
        resultados.push({
          caso:   cita['Numero de caso'],
          status: 'ips_no_encontrada',
          ips:    ipsAtencion,
        });
        continue;
      }

      const dataPaciente = {
        nombrePaciente: cita['Nombre del afiliado'],
        tipoDocumento:  cita['Tipo de documento del afiliado'],
        idNumber:       cita['Numero de documento del afiliado'],
        edad:           cita['Edad'],
        telefono:       cita['CELULAR'],
        grupoRiesgo:    cita['Código de diagnóstico'],
        servicio:       cita['Descripción del servicio'],
        ipsAtencion,
        contactoIPS:    datosIPS.contacto,
        numeroCaso:     cita['Numero de caso'],
        doctor:         cita['Doctor'],
        fecha:          cita['Fecha Sugerida'],
        hora:           cita['Hora Sugerida'],
      };

      const emailPrueba = "jorivera@coontacto.com.co";
      try {
        if (datosIPS.correo) {
          await envioSolicitudCita(emailPrueba, dataPaciente);
          resultados.push({
            caso:   cita['Numero de caso'],
            status: 'correo_enviado',
            email:  emailPrueba,
            ips:    ipsAtencion,
          });
          continue;
        }

        resultados.push({
            caso:        cita['Numero de caso'],
            status:      'notificar_paciente_wp',
            ips:         ipsAtencion,
            contactoIPS: datosIPS.contacto,
            paciente:    dataPaciente,
        });
      } catch (error) {
        console.error('Error enviando cita:', cita['Numero de caso'], error);
        resultados.push({ 
          caso: cita['Numero de caso'], 
          status: 'fallido', 
          email: emailPrueba, 
          ips: ipsAtencion,
          error: error.message
        });
      }
    }

    res.json({ 
      message: 'Proceso completado', 
      total: resultados.length,
      enviados: resultados.filter(r => r.status === 'enviado').length,
      fallidos: resultados.filter(r => r.status === 'fallido').length,
      resultados 
    });

  } catch (error) {
    console.error('Error procesando Excel:', error);
    res.status(500).json({ error: 'Error procesando el Excel' });
  }
};

const limpiarContactoIPS = (contacto) => {
  if (!contacto) return 'No disponible';

  // Extrae todos los números con formato colombiano
  // Cubre: 3001234567, 601-234-5678, (601) 234 5678, +57 300 123 4567
  const regex = /(?:\+?57[\s-]?)?(?:\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}/g;
  const matches = contacto.match(regex);

  if (!matches || matches.length === 0) return contacto.trim();

  // Limpia espacios/guiones y une los números encontrados
  return matches
    .map(n => n.replace(/[\s\-().]/g, ''))
    .filter((v, i, arr) => arr.indexOf(v) === i) // quita duplicados
    .join(' / ');
};  

export const enviarTemplateContactarPrestadorWP = async (req, res) => {
  const { nombrePaciente, servicio, ipsAtencion, telefono, contactoIPS } = req.body

  if (!telefono) {
      return res.status(400).json({ error: 'El campo telefono es requerido' });
    }
  if (!nombrePaciente || !servicio || !ipsAtencion) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const TEMPLATE_NAME_NOTIFICAR_PACIENTE = process.env.TEMPLATE_NAME_NOTIFICAR_PACIENTE;
  const TEMPLATE_LANGUAGE = process.env.TEMPLATE_LANGUAGE;
  const contactoLimpio = limpiarContactoIPS(contactoIPS);

  const whatsappBody = {
    messaging_product: "whatsapp",
    to: telefono,
    type: "template",
    template: {
        name: TEMPLATE_NAME_NOTIFICAR_PACIENTE,
        language: { code: TEMPLATE_LANGUAGE },
        components: [
            {
                type: "header",
                parameters: [
                    {
                        type: "image",
                        image: {
                            link: "https://mozartimages-1.s3.us-east-1.amazonaws.com/logo+de+coosalud.jpg"
                        }
                    }
                ]
            },
            {
                type: "body",
                parameters: [
                    { type: "text", text: nombrePaciente   },
                    { type: "text", text: servicio },
                    { type: "text", text: ipsAtencion      },
                    { type: "text", text: contactoLimpio    }
                ]
            }
        ]
    }
  };

  const response = await fetch(WHATSAPP_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(whatsappBody)
  });

  const data = await response.json();

  console.log("Respuesta completa:", JSON.stringify(data, null, 2));

  if (!response.ok) {
    console.error("Error:", data);
    return res.status(response.status).json(data);
  }

  return res.json({
    ok: true,
    messageId: data.messages?.[0]?.id,
    data
  });

}


export const enviarTemplateWP = async (req, res) => {
  const { telefono, nombrePaciente, servicio, ipsAtencion, fecha, hora } = req.body

  const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
  const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
  const TEMPLATE_NAME = process.env.TEMPLATE_NAME;
  const TEMPLATE_LANGUAGE = process.env.TEMPLATE_LANGUAGE;

  const whatsappBody = {
    messaging_product: "whatsapp",
    to: telefono,
    type: "template",
    template: {
        name: TEMPLATE_NAME,
        language: { code: TEMPLATE_LANGUAGE },
        components: [
            {
                type: "header",
                parameters: [
                    {
                        type: "image",
                        image: {
                            link: "https://mozartimages-1.s3.us-east-1.amazonaws.com/logo+de+coosalud.jpg"
                        }
                    }
                ]
            },
            {
                type: "body",
                parameters: [
                    { type: "text", text: nombrePaciente   },
                    { type: "text", text: servicio },
                    { type: "text", text: ipsAtencion      },
                    { type: "text", text: fecha    },
                    { type: "text", text: hora     }
                ]
            }
        ]
    }
  };

  const response = await fetch(WHATSAPP_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(whatsappBody)
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Error:", data);
    return res.status(response.status).json(data);
  }

  return res.json({
    ok: true,
    messageId: data.messages?.[0]?.id,
    data
  });

}


//HSM

export const detectarSesionExpiradaHSM = async (page) => {
  try {
    await page.waitForLoadState('domcontentloaded');

    const url = page.url();

    // 1. Redirección directa a login
    if (url.includes('/Login')) {
      return true;
    }

    // 2. Detectar botón de login por texto
    const botonLogin = await page.locator('button', {
      hasText: 'Colaboradores Coosalud'
    }).count();

    if (botonLogin > 0) {
      return true;
    }

    // 3. Validar si el formulario principal existe
    const formulario = await page.locator('#b1-Input_DocumentNumber19').count();

    if (formulario === 0) {
      return true;
    }

    return false;

  } catch (error) {
    console.log("Error detectando sesión:", error);
    return true;
  }
};

export const confirmarCitaHSMInicial = async (req, res) => {
const { usuario, clave, numeroCaso } = req.body
  try {
    // 1️⃣ Crear un perfil nuevo
    const profile = await client.profiles.create({
      name: `HSM-${usuario}`, // Nombre único por usuario
    });

    console.log("✅ Perfil creado:", profile.id);

    // 2️⃣ Crear sesión CON el perfil y persistChanges: true
    const session = await client.sessions.create({ 
      acceptCookies: true,
      profile: {
        id: profile.id,
        persistChanges: true, // 🔑 IMPORTANTE: Guarda el estado del navegador
      }
    });

    res.status(200).json({
      mensaje: "Proceso iniciado - Guardando perfil",
      liveUrl: session.liveUrl,
      profileId: profile.id, // 📌 Retorna el ID para guardarlo
    });

    console.log("preview:", session.liveUrl);

    (async () => {
      try {
        const browser = await chromium.connectOverCDP(session.wsEndpoint);
        const context = browser.contexts()[0];
        const page = context.pages()[0];

        await page.goto(`https://portal.coosalud.com/Login/?OriginalURL=https://portal.coosalud.com/HSM/managementReferenciaAmbulatoria?CaseNumber=${numeroCaso}&TextoPortal=HSM`);
      await page.locator('button:has-text("Colaboradores Coosalud")').click();
      await page.waitForLoadState('networkidle');
      await page.fill('#i0116', usuario);
      await page.click('#idSIButton9');
      await page.waitForSelector('#i0118', { timeout: 15000 });
        await page.fill('#i0118', clave);
        await page.click('#idSIButton9');

        

      } catch (error) {
        console.error("Error en proceso asíncrono:", error);
      }
    })();
  } catch (error) {
    console.error("❌ Error al iniciar:", error.message);

    if (!res.headersSent) {
      res.status(500).json({
        mensaje: "Error al iniciar el proceso",
        error: error.message,
      });
    }
  }
}

export const confirmarCitaHSM = async (req, res) => {
  const { numeroCaso, fechaCita, horaCita, direccionCita, nombreDoctor } = req.body

  const profileId = process.env.profileIdHSM || "dab90a80-9fa2-45ac-84e6-08baa803eeb7"
  const formatearFecha = (fecha, hora) => {
    const [dia, mes, anio] = fecha.split('/');
    return `${anio}-${mes}-${dia}T${hora}`;
  };

  const fechaFinal = formatearFecha(fechaCita, horaCita);

  const usuario = process.env.USUARIOHSM
  let session;
  let browser;

  try {
    session = await client.sessions.create({ 
      acceptCookies: true,
      saveDownloads: true,
      profile: {
        id: profileId,
        persistChanges: false,
      }
    });

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    let context = browser.contexts()[0];
    let page = context.pages()[0];

    await page.goto(
      `https://portal.coosalud.com/Login/?OriginalURL=https://portal.coosalud.com/HSM/managementReferenciaAmbulatoria?CaseNumber=${numeroCaso}&TextoPortal=HSM`,
      { waitUntil: 'networkidle' }
    );

    const sesionExpirada = await detectarSesionExpiradaHSM(page);

    if (sesionExpirada) {
      console.log("⚠️ Sesión expirada - Renovando perfil...");
      await browser.close();
      await client.sessions.stop(session.id);
      await new Promise(resolve => setTimeout(resolve, 2000));

      session = await client.sessions.create({ 
        acceptCookies: true,
        saveDownloads: true,
        profile: {
          id: profileId,
          persistChanges: true,
        }
      });

      browser = await chromium.connectOverCDP(session.wsEndpoint);
      context = browser.contexts()[0];
      page = context.pages()[0];
      
      await page.goto(`https://portal.coosalud.com/Login/?OriginalURL=https://portal.coosalud.com/HSM/managementReferenciaAmbulatoria?CaseNumber=${numeroCaso}&TextoPortal=HSM`);
      await page.locator('button:has-text("Colaboradores Coosalud")').click();
      await page.waitForLoadState('networkidle');
    }
    
    // Esperar a que cargue el formulario
    await page.waitForSelector('#b1-Input_DocumentNumber19');

    // Nombre del profesional
    await page.fill('#b1-Input_DocumentNumber19', nombreDoctor);

    // Dirección
    await page.fill('#b1-Input_DocumentNumber20', direccionCita);

    await page.evaluate((fechaFinal) => {
      const input = document.querySelector('#b1-Input_DateTimeVar7');
      input._flatpickr.setDate(fechaFinal, true);
    }, fechaFinal);


    // abrir el dropdown correcto
    await page.locator('.vscomp-toggle-button', {
      has: page.locator('.vscomp-value', { hasText: 'Por asignación de cita' })
    }).click();

    // esperar opciones
    const dropdown = page.locator('.vscomp-options-container:visible');

    // seleccionar opción correcta
    await dropdown.locator('.vscomp-option-text', {
      hasText: 'Por confirmar asistencia'
    }).click();

    // await page.locator('button', { hasText: 'Guardar' }).click();

    return res.status(200).json({
      ok: true,
      message: "Cita Actualizada en el HSM correctamente",
      data: {
        numeroCaso,
        fecha: fechaFinal
      }
    });

  } catch (error) {
    console.error("❌ Error en confirmarCitaHSM:", error);

    return res.status(500).json({
      ok: false,
      message: "Error al actualizar la cita en HSM",
      error: error.message
    });
  // } finally {
  //   // 🔹 LIMPIEZA
  //   try {
  //     if (browser) await browser.close();
  //     if (session) await client.sessions.stop(session.id);
  //   } catch (cleanupError) {
  //     console.error("Error cerrando recursos:", cleanupError);
  //   }
  }
}
