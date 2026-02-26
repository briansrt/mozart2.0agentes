import dotenv from "dotenv";
import { Hyperbrowser } from "@hyperbrowser/sdk";
import { chromium } from "playwright-core";
import { guardarResultadoEnCache, obtenerResultadoDeCache } from '../../../utils/memoryCache.js';
import { envioSolicitudCita } from '../../../config/twilio.js';

dotenv.config();

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

  await page.waitForTimeout(800);

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
  await inputBusqueda.clear();
  await inputBusqueda.pressSequentially(texto, { delay: 100 });

  await page.waitForTimeout(1000);

  const todasOpciones = dropdown.locator('.inputMultipleSelectOption');
  const count = await todasOpciones.count();

  console.log(`Total opciones tipoSolicitud: ${count}`);

  let ultimoPadre = null;

  for (let i = 0; i < count; i++) {
    const op = todasOpciones.nth(i);
    const textoOpcion = (await op.locator('.inputMultipleSelectOptionTitle').textContent())?.trim();
    const esPadre = await op.evaluate(el => el.classList.contains('inputMultipleSelectOptionParent'));

    if (esPadre) {
      ultimoPadre = textoOpcion;
      console.log(`Padre: "${ultimoPadre}"`);
      continue;
    }

    console.log(`  Hijo: "${textoOpcion}" | Padre actual: "${ultimoPadre}"`);

    // Verificar que el texto empiece con el código buscado (match exacto del código)
    const codigoHijo = textoOpcion?.split(' ')[0];
    if (codigoHijo?.toUpperCase() === texto.trim().toUpperCase()) {

      if (textoPadre) {
        if (!ultimoPadre?.toUpperCase().includes(textoPadre.trim().toUpperCase())) {
          console.log(`  ⚠️ Descartado por padre: "${ultimoPadre}" no coincide con "${textoPadre}"`);
          continue;
        }
      }

      console.log(`✅ Seleccionando: "${textoOpcion}" bajo "${ultimoPadre}"`);
      await op.scrollIntoViewIfNeeded();
      await op.click();
      return;
    }
  }

  throw new Error(`No se encontró tipoSolicitud "${texto}"${textoPadre ? ` bajo "${textoPadre}"` : ''}`);
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
  const { prioridad, riesgoVital, priorizado, regimen, sucursal, municipioResidencia, entidadSolicitud, codigoMotivo, tipoDocumento, idNumber, nombre, telefono, correo, asuntoCaso, descripcionCaso, usuario, clave } = req.body;

  const indice = descripcionCaso.indexOf('Usuario');
  const descripcionFinal = indice !== -1 ? descripcionCaso.substring(indice) : descripcionCaso;
  const asuntoLimpio = asuntoCaso.replace(/^Asunto:\s*/, '').trim();

  const tipoCanalRecepcion = "Canal";
  const canalRecepcion = "Línea";
  const profileId = process.env.profileIdCoosalud
  const ipsInductora = "NO APLICA";

  try {
    await guardarResultadoEnCache(idNumber, {
      idNumber: idNumber,
      estado: "procesando",
      motivo: "Creando PQRS...",
      radicado: null,
      timestamp: new Date().toISOString()
    });
    // Intentar con el perfil existente
    let session = await client.sessions.create({ 
      acceptCookies: true,
      saveDownloads: true,
      profile: {
        id: profileId,
        persistChanges: false,
      }
    });

    res.status(200).json({
      mensaje: "Estoy creando la PQRS, un momento por favor...",
      liveUrl: session.liveUrl,
      estado: "procesando",
      idNumber: idNumber
    });

    (async () => {

      let numeroRadicado = {
        idNumber: idNumber,
        estado: "procesando",
        radicado: false,
        motivo: "",
        timestamp: new Date().toISOString()
      };

      try {
        let browser = await chromium.connectOverCDP(session.wsEndpoint);
        let context = browser.contexts()[0];
        let page = context.pages()[0];

        await page.goto(
          "https://coosalud.sd.cloud.invgate.net/auth/login/type/servicedesk",
          { waitUntil: 'networkidle' }
        );

        const sesionExpirada = await detectarSesionExpiradaCoosalud(page);

        if (sesionExpirada) {
          console.log("⚠️ Sesión expirada - Renovando perfil...");
          
          // 🔄 Cerrar sesión actual
          await browser.close();
          await client.sessions.stop(session.id);

          // ⏳ Esperar 2 segundos para que se libere el perfil
          await new Promise(resolve => setTimeout(resolve, 2000));

          // 🆕 NUEVA SESIÓN CON persistChanges: true para actualizar perfil
          session = await client.sessions.create({ 
            acceptCookies: true,
            saveDownloads: true,
            profile: {
              id: profileId,
              persistChanges: true, // 🔑 Ahora sí guardamos cambios
            }
          });

          browser = await chromium.connectOverCDP(session.wsEndpoint);
          context = browser.contexts()[0];
          page = context.pages()[0];
          
          await page.goto(
            "https://coosalud.sd.cloud.invgate.net/auth/login/type/servicedesk"
          );

          // Re-login
          await page.locator('a.button.button--auto', { hasText: 'Funcionarios Coosalud' }).click();

          await page.waitForLoadState('networkidle');

          console.log("✅ Perfil renovado con nueva sesión");
        }

        // Continuar con el flujo normal
        console.log("liveurl: ", session.liveUrl)

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

        //Formulario
        await seleccionarSelectPorTexto(page, '#form_create_priority', prioridad);
        await seleccionarSelectPorTexto(page, '#custom_field_44479', riesgoVital);
        await seleccionarSelectPorTexto(page, '#custom_field_44480', priorizado);
        await seleccionarSelectPorTexto(page, '#custom_field_44471', regimen);
        await seleccionarSelectPorTexto(page, '#custom_field_46454', sucursal);
        await seleccionarTreeSelectConBuscador(page, '#custom_field_46455', municipioResidencia);
        await seleccionarTipoSolicitud(page, '#custom_field_44469', codigoMotivo, entidadSolicitud);
        await seleccionarTipoSolicitud(page, '#custom_field_44752', canalRecepcion, tipoCanalRecepcion);
        await seleccionarSelectPorTexto(page, '#custom_field_46457', tipoDocumento);
        await page.fill('#custom_field_44464', idNumber);
        await page.fill('#custom_field_46453', nombre);
        await page.fill('#custom_field_44467', telefono);
        await page.fill('#custom_field_44468', correo);
        await seleccionarSelectPorTexto(page, '#custom_field_46464', ipsInductora);
        await page.fill('#form_create_subject', asuntoLimpio);
        
        await page.waitForSelector('iframe.cke_wysiwyg_frame', { timeout: 10000 });
        const frame = await (
          await page.waitForSelector('iframe.cke_wysiwyg_frame')
        ).contentFrame();
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

        if (sesionExpirada) {
          await client.sessions.stop(session.id);
        }

        numeroRadicado = {
         idNumber:idNumber,
          estado: "completado",
          radicado: requestId,
          motivo: `PQRS Creado con el numero radicado: ${requestId}`,
          timestamp: new Date().toISOString()
        };
        
        // Guardar resultado final en cache
        await guardarResultadoEnCache(idNumber, numeroRadicado);
                
        console.log(`✅ Proceso completado para documento ${idNumber}`);

      } catch (error) {
        console.error("Error en proceso:", error);
        numeroRadicado = {
          idNumber: idNumber,
          estado: "error",
          radicado: false,
          motivo: "Error al procesar la solicitud",
          error: error.message,
          timestamp: new Date().toISOString()
        };
                
        // Guardar error en cache
        await guardarResultadoEnCache(idNumber, numeroRadicado);
      } finally {
        console.log("🔒 Cerrando sesión Hyperbrowser...");

        try {
          if (browser) {
            await browser.close();
          }
        } catch (e) {
          console.log("Error cerrando browser:", e.message);
        }

        console.log("✅ Sesión cerrada correctamente");
      }
    })();

  } catch (error) {
    console.error("❌ Error:", error.message);

    if (!res.headersSent) {
      res.status(500).json({
        mensaje: "Error al iniciar el proceso",
        error: error.message,
      });
    }
  }
}


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
export const enviarCorreo = async (req, res) => {
  try {
    const {
      nombrePaciente,
      tipoDocumento,
      idNumber,
      edad,
      telefono,
      grupoRiesgo,
      servicio,
      ipsAtencion,
      numeroCaso
    } = req.body;

    const email="brian.riofrio@mozartai.com.co"

    if (!email) {
      return res.status(400).json({ error: "Falta el campo email" });
    }

    const dataPaciente = {
      nombrePaciente,
      tipoDocumento,
      idNumber,
      edad,
      telefono,
      grupoRiesgo,
      servicio,
      ipsAtencion,
      numeroCaso
    };

    // Llamada a la función que envía el correo
    await envioSolicitudCita(email, dataPaciente);

    res.json({ message: "Correo enviado correctamente" });
  } catch (error) {
    console.error("Error enviando correo:", error);
    res.status(500).json({ error: "Error enviando correo" });
  }
};