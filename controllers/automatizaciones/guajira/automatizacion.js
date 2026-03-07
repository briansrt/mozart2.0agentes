import dotenv from "dotenv";
import { Hyperbrowser } from "@hyperbrowser/sdk";
import { chromium } from "playwright-core";
import { guardarResultadoEnCache, obtenerResultadoDeCache } from '../../../utils/memoryCache.js';
import { transformarAutorizacionesGuajira } from "../../../utils/excel/transformarAutorizaciones.js";
import { generarExcelBuffer } from "../../../utils/excel/escribirExcel.js";
import moment from "moment-timezone";

dotenv.config();

let browser, page, session;
let contextGlobal;
let pageMozartia;

const client = new Hyperbrowser({
  apiKey: process.env.HYPERBROWSER_API_KEY,
});


const detectarSesionExpiradaGuajira = async (page) => {
  try {
    // Esperar un momento a que la página estabilice
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    console.log("🔎 URL actual:", currentUrl);

    // 1️⃣ Si estamos en login, la sesión expiró
    if (currentUrl.includes("/sso/login")) {
      console.log("⚠️ Detectado login por URL");
      return true;
    }

    // 2️⃣ Si existe el input de usuario, también es login
    const inputUsuario = page.locator("input[name='username']");
    if (await inputUsuario.count() > 0) {
      console.log("⚠️ Detectado formulario de login por selector");
      return true;
    }

    // 3️⃣ Buscar mensaje explícito de sesión expirada
    const textoExpirado = await page.locator("text=/sesión.*expirada/i").count();
    if (textoExpirado > 0) {
      console.log("⚠️ Detectado mensaje de sesión expirada");
      return true;
    }

    // 4️⃣ Validar que realmente estamos dentro del módulo correcto
    const estaEnValidador = currentUrl.includes("ValidacionDerechos");
    if (estaEnValidador) {
      console.log("✅ Sesión activa");
      return false;
    }

    // 5️⃣ Fallback defensivo
    console.log("⚠️ Estado incierto, asumiendo sesión expirada por seguridad");
    return true;

  } catch (error) {
    console.error("Error detectando sesión:", error);
    return true; // por seguridad, forzar renovación
  }
};

const detectarSesionExpiradaCristal = async (page) => {
  try {
    await page.waitForLoadState("domcontentloaded");

    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {
      console.log("⏱️ networkidle no alcanzado, continuando...");
    });

    const currentUrl = page.url();
    console.log("🔎 URL actual:", currentUrl);

    // 1️⃣ Si está en login, sesión expiró
    if (currentUrl.includes("/autenticarse")) {
      console.log("⚠️ Detectado login por URL");
      return true;
    }

    // 2️⃣ Si está en el módulo correcto, sesión activa
    if (currentUrl.includes("/ce")) {
      console.log("✅ Sesión activa por URL");
      return false;
    }

    // 3️⃣ Solo si la URL es ambigua, revisar DOM en paralelo
    const [tieneUsuario, tieneClave, tieneMensaje] = await Promise.all([
      page.locator('input[aria-label="Usuario *"]').count(),
      page.locator('input[aria-label="Clave Secreta *"]').count(),
      page.locator('text=Su sesión ha expirado').count(),
    ]);

    if (tieneUsuario > 0 || tieneClave > 0 || tieneMensaje > 0) {
      console.log("⚠️ Detectado formulario de login por DOM");
      return true;
    }

    // 4️⃣ Fallback defensivo
    console.log("⚠️ Estado incierto, asumiendo sesión expirada");
    return true;

  } catch (error) {
    console.error("Error detectando sesión:", error);
    return true;
  }
};


//AUTORIZACIONES GUAJIRA
export const AutorizacionGuajiraInicial = async (req, res) => {
  const { usuario, clave, documento } = req.body;

  try {
    // 1️⃣ Crear un perfil nuevo
    const profile = await client.profiles.create({
      name: `Guajira-${usuario}`, // Nombre único por usuario
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
          "https://portal.colsanitas.com/sso/login?service=https%3A%2F%2Fappcore.colsanitas.com%2FValidadorDerechos%2Fpages%2Fgestion%2FValidacionDerechos.seam%3Fcid%3D2349",
        );

        // LOGIN
        await page.fill("input[name='username']", usuario);
        await page.waitForTimeout(1000);
        await page.fill("input[name='password']", clave);

        // Hacer click en ingresar y esperar que la URL cambie a la del portal
        await page.waitForTimeout(1000);
        await page
          .locator("input[type='submit'][value='Ingresar']")
          .click({ force: true });
        // Esperar que se procese el login
        await page.waitForTimeout(5000);

        // Función para verificar si llegamos a la página correcta
        const verificarPaginaCargada = async () => {
          try {
            const url = page.url();
            console.log("URL actual:", url);

            if (url.includes("ValidacionDerechos.seam")) {
              const tieneFormulario =
                (await page
                  .locator("#formaVDGeneral\\:selectOneTipoDoc")
                  .count()) > 0;
              return tieneFormulario;
            }
            return false;
          } catch {
            return false;
          }
        };

        // Intentar múltiples estrategias
        let paginaLista = await verificarPaginaCargada();

        if (!paginaLista) {
          console.log("Navegando directamente a la URL...");

          for (let i = 0; i < 3; i++) {
            try {
              await page.goto(
                "https://appcore.colsanitas.com/ValidadorDerechos/pages/gestion/ValidacionDerechos.seam?cid=2349",
                { timeout: 20000, waitUntil: "domcontentloaded" },
              );

              await page.waitForTimeout(2000);
              paginaLista = await verificarPaginaCargada();

              if (paginaLista) {
                console.log("Página cargada correctamente");
                break;
              }

              console.log(`Intento ${i + 1}: Página no lista, refrescando...`);
              await page.reload({ timeout: 20000 });
              await page.waitForTimeout(3000);
            } catch (error) {
              console.log(`Error en intento ${i + 1}:`, error.message);
              if (i < 2) {
                await page.waitForTimeout(2000);
              }
            }
          }
        }

        if (!paginaLista) {
          throw new Error("No se pudo cargar la página de validación");
        }

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


export const AutorizacionGuajira = async (req, res) => {
  const { documento, profileId, usuario, clave, tipoDocumento, tenant } = req.body;

  let session, browser, page;

  const URL_PORTAL =
    "https://portal.colsanitas.com/sso/login?service=https%3A%2F%2Fappcore.colsanitas.com%2FValidadorDerechos%2Fpages%2Fgestion%2FValidacionDerechos.seam%3Fcid%3D2349";

  try {
    // Guardar estado inicial en cache
    await guardarResultadoEnCache(documento, {
      documento: documento,
      estado: "procesando",
      puedeAgendar: false,
      motivo: "Verificando autorización...",
      datos: null,
      timestamp: new Date().toISOString()
    });

    session = await client.sessions.create({
      acceptCookies: true,
      saveDownloads: true,
      profile: { id: profileId, persistChanges: false },
    });

    // Responder inmediatamente
    res.status(200).json({ 
      mensaje: "Estoy verificando la autorización, un momento por favor...",
      liveUrl: session.liveUrl,
      estado: "procesando",
      documento: documento
    });

    // Proceso en background
    (async () => {
      let resultadoFinal = {
        documento: documento,
        estado: "procesando",
        puedeAgendar: false,
        motivo: "",
        datos: null,
        timestamp: new Date().toISOString()
      };

      try {
        browser = await chromium.connectOverCDP(session.wsEndpoint);
        page = browser.contexts()[0].pages()[0];

        await page.goto(URL_PORTAL, { waitUntil: "networkidle" });

        const sesionExpirada = await detectarSesionExpiradaGuajira(page);
        if (sesionExpirada) {
          await browser.close();
          await client.sessions.stop(session.id);
          await new Promise((r) => setTimeout(r, 2000));

          session = await client.sessions.create({
            acceptCookies: true,
            saveDownloads: true,
            profile: { id: profileId, persistChanges: true },
          });

          browser = await chromium.connectOverCDP(session.wsEndpoint);
          page = browser.contexts()[0].pages()[0];

          await page.goto(URL_PORTAL);
          await page.fill("input[name='username']", usuario);
          await page.waitForTimeout(1000);
          await page.fill("input[name='password']", clave);
          await page.waitForTimeout(1000);
          await page.locator("input[type='submit'][value='Ingresar']").click({ force: true });
          await page.waitForTimeout(5000);
        }

        await page.locator("label", { hasText: "Tipo y Num Identificación" }).waitFor({ state: "visible", timeout: 90000 });
        await page.locator("label", { hasText: "Tipo y Num Identificación" }).click();
        await page.waitForTimeout(2000);
        await page.locator("#formaVDGeneral\\:selectOneTipoDoc").selectOption({ label: tipoDocumento });
        await page.fill("#formaVDGeneral\\:numDocumento", documento);
        await page.locator("#formaVDGeneral\\:j_id77").click();
        await page.waitForTimeout(3000);

        await page.locator("#formaVDGeneral\\:selectOneCiaId").selectOption({ label: "Todas" });
        await page.waitForTimeout(1000);

        const opciones = page.locator("#formaVDGeneral\\:selectOnePlanFam label");
        let tipoEntidad = null;

        for (let i = 0; i < (await opciones.count()); i++) {
          const texto = await opciones.nth(i).innerText();
          if (texto.includes("EPS") || texto.includes("COLSANITAS") || texto.includes("COOMEVA")) {
            tipoEntidad = texto.includes("EPS") ? "EPS" : texto.includes("COLSANITAS") ? "COLSANITAS" : "COOMEVA";
            await opciones.nth(i).click();
            break;
          }
        }

        if (!tipoEntidad) throw new Error("Entidad no reconocida (EPS/COLSANITAS/COOMEVA)");

        await page.locator("#formaVDGeneral\\:btnConsultarUsuario").click();
        await page.waitForSelector("#info-usuario", { timeout: 30000 });

        const datosUsuario = await page.evaluate(() => {
          const c = document.querySelector("#info-usuario");
          const val = (label) =>
            Array.from(c.querySelectorAll("label"))
              .find((l) => l.innerText.includes(label))
              ?.parentElement.querySelector(".info-dato")
              ?.innerText.trim() ?? null;
          return {
            nombre: c.querySelector("h2")?.innerText.trim() ?? null,
            estado: val("Estado"),
          };
        });

        const esActivo = ["ACTIVO", "VIGENTE"].includes(datosUsuario.estado?.toUpperCase());
        const nombreFormateado = datosUsuario.nombre
          ?.split(/[,|_]/)                       
          .map(word => word.trim())              
          .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
          .join(" ");                        

        const filaTabla = {
          cedula:             documento,
          nombres:            nombreFormateado,
          motivo:             "",
        };

        if (!esActivo) {
          filaTabla.motivo = "Paciente inactivo";
          filaTabla.puedeAgendar = false;

        } else if (tipoEntidad === "COLSANITAS" || tipoEntidad === "COOMEVA") {
          filaTabla.puedeAgendar = true;

        } else if (tipoEntidad === "EPS") {
          await page.locator("label", { hasText: "Servicios con Autorización" }).waitFor({ state: "visible", timeout: 90000 });
          await page.locator("label", { hasText: "Servicios con Autorización" }).click();
          await page
            .locator("#formaVDGeneral\\:servicios\\:includeSeleccionUsuario\\:formaSeleccionUsuario\\:continuarPaso0")
            .click();
          await page.waitForTimeout(5000);

          const mensajeNoAutorizacion = await page.locator(
            "#formaVDGeneral\\:servicios\\:includeSeleccionUsuario\\:formaSeleccionUsuario .rich-messages-label"
          ).elementHandles();

          if (mensajeNoAutorizacion.length > 0) {
            const texto = await mensajeNoAutorizacion[0].innerText();
            if (texto.includes("El usuario no tiene volantes expedidos")) {
              filaTabla.motivo = "No tiene autorizaciones expedidas para el prestador";
              filaTabla.puedeAgendar = false;
            }
          } else {
            await page.waitForSelector(
              "#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:detListPrest",
              { timeout: 30000 }
            );

            const autorizaciones = await page.evaluate(() => {
              const tbody = document.querySelector(
                "#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:detListPrest\\:tb"
              );
              if (!tbody) return [];

              return Array.from(tbody.querySelectorAll("tr.rich-table-row")).map((fila) => {
                const celdas    = fila.querySelectorAll("td");
                const subFila   = fila.nextElementSibling?.classList.contains("rich-subtable-row")
                  ? fila.nextElementSibling : null;
                const celdasSub = Array.from(subFila?.querySelectorAll("td") || []);

                return {
                  numeroAutorizacion: celdas[1]?.innerText.trim(),
                  fechaVigencia:      celdas[4]?.innerText.trim(),
                  estado:             celdas[5]?.innerText.trim(),
                  prestador:          celdas[6]?.innerText.trim(),
                  codigo:             celdasSub[1]?.innerText.trim(),
                  descripcion:        celdasSub[2]?.innerText.trim(),
                };
              });
            });

            const hoy = moment().tz("America/Bogota").startOf("day");

            const autorizacionesValidas = autorizaciones.filter((a) =>
              a.estado?.toUpperCase() === "APROBADA" &&
              a.prestador?.toUpperCase().includes("CLINICA ESPERANZA SAS") &&
              moment
                .tz(a.fechaVigencia, "DD/MM/YYYY", "America/Bogota")
                .endOf("day")
                .isSameOrAfter(hoy)
            );

            if (!autorizacionesValidas.length) {
              filaTabla.motivo = "No tiene autorizaciones válidas para CLINICA ESPERANZA SAS";
              filaTabla.puedeAgendar = false;
            } else {
              filaTabla.puedeAgendar = true;

              // Iterar sobre TODAS las autorizaciones válidas
              const autorizacionesConDetalle = [];

              for (const aut of autorizacionesValidas) {
                const autBase = {
                  fechaExpedicion: aut.fechaVigencia,
                  servicio: `${aut.codigo} - ${aut.descripcion}`,
                  numeroAutorizacion: aut.numeroAutorizacion,
                  numeroRadicacion: aut.numeroAutorizacion,
                };

                // Encontrar el índice real de esta autorización en la tabla original
                const indiceReal = autorizaciones.findIndex(
                  (a) => a.numeroAutorizacion === aut.numeroAutorizacion
                );

                if (indiceReal === -1) {
                  autorizacionesConDetalle.push(autBase);
                  continue;
                }

                try {
                  // Abrir modal de detalles
                  await page.locator("a", { hasText: "Mostrar" }).nth(indiceReal).click();
                  await page.waitForSelector("#buscandoDetalle", { state: "hidden", timeout: 30000 });
                  await page.waitForTimeout(2000);

                  const infoModal = await page.evaluate(() => {
                    const contenedor = document.querySelector(
                      "#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:detalle-volanteContentDiv"
                    );
                    if (!contenedor) return null;

                    const style = window.getComputedStyle(contenedor.parentElement.parentElement);
                    if (style.display === "none") return null;

                    const tabla = contenedor.querySelector("#tablaDetalleVolante");
                    if (!tabla) return null;

                    const datos = {};
                    const filas = tabla.querySelectorAll("tbody > tr");

                    for (let fila of filas) {
                      const celdas = fila.querySelectorAll("td");
                      if (celdas.length === 2 && !celdas[0].hasAttribute("colspan")) {
                        const label = celdas[0].textContent.trim();
                        const valor = celdas[1].textContent.trim();
                        if (label === "Lugar") datos.modalidad = valor;
                        else if (label === "Prestador que ordena:") datos.prestador = valor;
                      }
                    }

                    const obsCodif = [];
                    const tablaObsCodif = contenedor.querySelector("#tablaDetalleVolObsCodif tbody");
                    if (tablaObsCodif) {
                      tablaObsCodif.querySelectorAll("tr").forEach((tr) => {
                        const celdas = tr.querySelectorAll("td");
                        if (celdas.length === 2) {
                          obsCodif.push({
                            codigo: celdas[0].textContent.trim(),
                            observacion: celdas[1].textContent.trim(),
                          });
                        }
                      });
                    }

                    datos.observacionesCodificadas = obsCodif;
                    return datos;
                  });

                  if (infoModal) {
                    autBase.modalidad = infoModal.modalidad;
                    autBase.prestadorQueOrdena = infoModal.prestador;
                    autBase.observacionesCodificadas = infoModal.observacionesCodificadas;
                  }

                  // Cerrar modal
                  await page.evaluate(() => {
                    const modal = document.getElementById(
                      "formaVDGeneral:servicios:includeInformacionServicio:frm:includeRegistroAdmisionVolantes:frm:formaConsultaVolantes:detalle-volante"
                    );
                    if (modal?.component) modal.component.hide();
                  });
                  await page.waitForTimeout(1500);

                  // Click en Seleccionar usando el índice real
                  await page.locator(
                    `#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:detListPrest\\:${indiceReal}\\:linkSeleccionarVol2`
                  ).click();

                  await page.waitForSelector(
                    "#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:selectCausaExterna",
                    { state: "visible", timeout: 30000 }
                  );
                  await page.waitForTimeout(2000);

                  const infoRips = await page.evaluate(() => {
                    const getSelectedText = (id) => {
                      const el = document.getElementById(id);
                      return el?.options[el.selectedIndex]?.text?.trim() ?? null;
                    };
                    const p = "formaVDGeneral:servicios:includeInformacionServicio:frm:includeRegistroAdmisionVolantes:frm:formaConsultaVolantes:";
                    const diagTabla = document.querySelector("#diagnosticoContainer tbody tr");

                    return {
                      causaExterna:         getSelectedText(p + "selectCausaExterna"),
                      grupoServicio:        getSelectedText(p + "selectGroupService"),
                      modalidadAtencion:    getSelectedText(p + "selectModeOfCare"),
                      finalidad:            getSelectedText(p + "selectFinalidad"),
                      diagnosticoPrincipal: {
                        codigo:      diagTabla?.querySelector("td:nth-child(1)")?.innerText?.trim() ?? null,
                        descripcion: diagTabla?.querySelector("td:nth-child(2)")?.innerText?.trim() ?? null,
                      },
                    };
                  });

                  if (infoRips) {
                    autBase.rips = infoRips;
                  }

                } catch (err) {
                  console.warn(`⚠️ Error extrayendo detalle de autorización ${aut.numeroAutorizacion}:`, err.message);
                }

                autorizacionesConDetalle.push(autBase);
              }

              filaTabla.autorizaciones = autorizacionesConDetalle;
            }
          }
        }

        console.log("✅ Fila lista para la tabla:", JSON.stringify(filaTabla, null, 2));
        // const filasExcel = transformarAutorizacionesGuajira(filaTabla);
        // const buffer = generarExcelBuffer(filasExcel);

        // const contextGlobal = browser.contexts()[0];
        // const pageMozartia = await contextGlobal.newPage();

        // await pageMozartia.goto(`https://new.app.mozartia.com/${tenant}/login`, {
        //   waitUntil: "networkidle",
        // });

        // await pageMozartia
        //   .locator('input[name="email"]')
        //   .fill(process.env.mozartEmail);
        // await pageMozartia
        //   .locator('input[name="password"]')
        //   .fill(process.env.mozartPassword);
        // await pageMozartia
        //   .getByRole("button", { name: /Acceder al Sistema/i })
        //   .click();

        // await pageMozartia.waitForFunction(
        //   (tenant) => {
        //     return (
        //       location.pathname.startsWith(`/${tenant}`) ||
        //       location.pathname.startsWith("/medical-authorizations")
        //     );
        //   },
        //   tenant,
        //   { timeout: 60000 },
        // );

        // await pageMozartia.getByRole("button", { name: /Aceptar/i }).click();

        // await pageMozartia.goto(
        //   "https://new.app.mozartia.com/cemdiprueba/medical-authorizations",
        //   { waitUntil: "networkidle" },
        // );

        // await pageMozartia
        //   .getByRole("button", {
        //     name: /Carga Masiva/i,
        //   })
        //   .waitFor({ state: "visible" });

        // await pageMozartia
        //   .getByRole("button", {
        //     name: /Carga Masiva/i,
        //   })
        //   .click();

        // const fileInput = pageMozartia.locator(
        //   'input[type="file"][accept*=".xlsx"]',
        // );

        // await fileInput.waitFor({ state: "visible" });

        // await fileInput.setInputFiles({
        //   name: "autorizaciones.xlsx",
        //   mimeType:
        //     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        //   buffer: buffer,
        // });

        // const cargarBtn = pageMozartia.getByRole("button", {
        //   name: /Cargar Archivo/i,
        // });

        // await pageMozartia
        //   .locator('button:not([disabled]):has-text("Cargar Archivo")')
        //   .waitFor({ state: "visible", timeout: 15000 });

        // await cargarBtn.click();
        // console.log("✅ Excel subido a Mozart");

        // if (sesionExpirada) await client.sessions.stop(session.id);

        resultadoFinal = {
          documento: documento,
          estado: "completado",
          puedeAgendar: filaTabla.puedeAgendar,
          motivo: filaTabla.motivo,
          datos: filaTabla,
          filasExcel: filasExcel,
          timestamp: new Date().toISOString()
        };

        // Guardar resultado final en cache
        await guardarResultadoEnCache(documento, resultadoFinal);
        
        console.log(`✅ Proceso completado para documento ${documento}`);

      } catch (err) {
        console.error("❌ Error en proceso asíncrono:", err);
        resultadoFinal = {
          documento: documento,
          estado: "error",
          puedeAgendar: false,
          motivo: "Error al procesar la solicitud",
          error: err.message,
          timestamp: new Date().toISOString()
        };
        
        // Guardar error en cache
        await guardarResultadoEnCache(documento, resultadoFinal);
      }
    })();

  } catch (err) {
    console.error("❌ Error:", err.message);
    if (!res.headersSent)
      res.status(500).json({ mensaje: "Error al iniciar el proceso", error: err.message });
  }
};

// Endpoint para consultar el resultado
export const ConsultarAutorizacion = async (req, res) => {
  // Ahora recibimos 'documento' desde el body en lugar de params
  const { documento } = req.body;

  if (!documento) {
    return res.status(400).json({ 
      estado: "error",
      mensaje: "Falta el parámetro 'documento'"
    });
  }

  try {
    const resultado = await obtenerResultadoDeCache(documento);

    if (!resultado) {
      return res.status(404).json({ 
        estado: "no_encontrado",
        mensaje: "No se encontró información para este documento"
      });
    }

    return res.status(200).json({
      estado: "encontrado",
      documento,
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



async function seleccionarCita(page, fecha, hora) {
  const fechaHora = `${fecha} ${hora}`;
  await page.waitForTimeout(3000);

  while (true) {
    await page.waitForSelector('.q-table tbody tr.q-tr', { timeout: 5000 });

    // Buscar la celda de fecha que contenga el texto exacto
    const celdaFecha = page.locator('.q-table tbody tr.q-tr td', {
      hasText: fechaHora
    }).first();

    if (await celdaFecha.count() > 0) {
      // Subir al <tr> padre y hacer click
      const filaParent = celdaFecha.locator('xpath=..');
      await filaParent.scrollIntoViewIfNeeded();
      await filaParent.click();
      console.log("✅ Cita encontrada:", fechaHora);
      return true;
    }

    const botonSiguiente = page.locator(
      'button[aria-label="Próxima página"]:not([disabled])'
    );

    if (await botonSiguiente.count() === 0) {
      console.log("❌ No se encontró la cita:", fechaHora);
      return false;
    }

    console.log("➡️ Pasando a la siguiente página");
    await botonSiguiente.click();
    await page.waitForTimeout(1500);
  }
}


export const AgendarCitaGuajiraCristaInicial = async (req, res) => {
  const { usuario, clave } = req.body
  try {
    // 1️⃣ Crear un perfil nuevo
    const profile = await client.profiles.create({
      name: `Cristal-Prueba${usuario}`, // Nombre único por usuario
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
          "https://api-test.qrystalos.com/#/autenticarse",
        );
        await page.waitForLoadState("networkidle");

        // LOGIN
        // Organización
        await page.waitForSelector('input[aria-label="Organización *"]');
        await page.fill('input[aria-label="Organización *"]', 'Pruebas Clinica esperanza');
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");

        // Usuario
        await page.waitForSelector('input[aria-label="Usuario *"]');
        await page.fill('input[aria-label="Usuario *"]', usuario);

        // Contraseña
        await page.fill('input[type="password"]', clave);

        // Click continuar
        await page.click('button:has-text("Continuar")');

        // Esperar navegación después del login
        await page.waitForLoadState("networkidle");

        console.log("✅ Login completado - Perfil guardado");
        
        // 🔑 IMPORTANTE: Cerrar sesión para que el perfil se guarde
        await client.sessions.stop(session.id);
        

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

export const AgendarCitaGuajiraCristal = async (req, res) => {
  const { documento, fechaCita, horaCita, centroCosto, codigoServicio, tipoAtencion, numeroAutorizacion, fechaAutorizacion, fechaVencimiento, copago, valorCopago, tipoCopago, valorCita, observaciones, acompanante,responsable } = req.body

  const [fechaCitaFormateada, fechaAutorizacionFormateada, fechaVencimientoFormateada] =
  [fechaCita, fechaAutorizacion, fechaVencimiento].map(f => f.split('/').reverse().join('-'));

  const usuario = process.env.USUARIOGUAJIRA
  const clave = process.env.CLAVEGUAJIRA
  const profileId = process.env.profileIdGuajira


  try {
    // Intentar con el perfil existente
    let session = await client.sessions.create({ 
      acceptCookies: true,
      profile: {
        id: profileId,
        persistChanges: true,
      }
    });

    let browser = await chromium.connectOverCDP(session.wsEndpoint);
    let context = browser.contexts()[0];
    let page = context.pages()[0];
    let procesando = true;

    const manejarModalActualizacion = (paginaActual) => {
      (async () => {
        while (procesando) {
          try {
            const btnPostergar = paginaActual.locator('.q-dialog button span.block', {
              hasText: 'Postergar'
            }).first();
            if (await btnPostergar.count() > 0) {
              console.log("🔔 Modal de actualización detectado - Postergando...");
              await btnPostergar.click();
            }
          } catch (e) {}
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      })();
    };

    manejarModalActualizacion(page);

    await page.goto("https://api-test.qrystalos.com/#/ce", { waitUntil: "networkidle" });

    const sesionExpirada = await detectarSesionExpiradaCristal(page);

    if (sesionExpirada) {
      console.log("⚠️ Sesión expirada - Renovando perfil...");
      procesando = false;

      await browser.close();
      await client.sessions.stop(session.id);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 🔑 Nueva sesión con el liveUrl correcto
      session = await client.sessions.create({
        acceptCookies: true,
        saveDownloads: true,
        profile: { id: profileId, persistChanges: true }
      });

      res.status(200).json({
        mensaje: "Proceso iniciado",
        liveUrl: session.liveUrl,
      });

      browser = await chromium.connectOverCDP(session.wsEndpoint);
      context = browser.contexts()[0];
      page = context.pages()[0];

      procesando = true;
      manejarModalActualizacion(page);

      // Login
      await page.goto("https://api-test.qrystalos.com/#/autenticarse");

      const selectorInput = 'input[aria-label="Organización *"]';
      await page.click(selectorInput);
      await page.fill(selectorInput, 'Pruebas Clinica esperanza');
      await page.waitForSelector('div.q-item span:has-text("Pruebas Clinica esperanza")');
      await page.click('div.q-item span:has-text("Pruebas Clinica esperanza")');

      const usuarioInput = page.locator('input[aria-label="Usuario *"]').first();
      await usuarioInput.waitFor({ state: 'attached' });
      await usuarioInput.fill(usuario);

      const claveInput = page.locator('input[aria-label="Clave Secreta *"]').first();
      await claveInput.waitFor({ state: 'attached' });
      await claveInput.fill(clave);

      await page.click('button:has-text("Continuar")');
      await page.waitForLoadState("networkidle");

      console.log("✅ Perfil renovado con nueva sesión");
    }

    (async () => {
      try {

        // Continuar con el flujo normal
        await page.goto("https://api-test.qrystalos.com/#/ce", {
          waitUntil: "networkidle"
        });

        await page.waitForTimeout(3000);

        await page.goto("https://api-test.qrystalos.com/#/ce/agendamiento", {
          waitUntil: "networkidle"
        });

        console.log("✅ Entró a Agenda correctamente");

        // 1️⃣ Click al botón de acción (recargar)
        await page.waitForSelector('.accion-btn', { timeout: 10000 });
        await page.click('.accion-btn');

        // 2️⃣ Escribir documento
        await page.waitForSelector('input[placeholder="Doc. Identificación"]');

        await page.fill('input[placeholder="Doc. Identificación"]', documento);

        // esperar que cargue la búsqueda
        await page.waitForTimeout(1500);

        // 3️⃣ Esperar la tabla con resultados
        await page.waitForSelector('.q-table tbody tr.q-tr.cursor-pointer');

        // 4️⃣ Buscar la fila que tenga el documento
        const fila = page.locator('.q-table tbody tr.q-tr.cursor-pointer', {
          hasText: documento
        }).first();

        await fila.waitFor();
        await fila.click();

        // esperar que aparezca el panel expandido
        const botonSeleccionar = page.locator('button', {
          hasText: 'Seleccionar'
        }).last(); // usamos el último porque el primero es otro

        await botonSeleccionar.waitFor({ state: "visible" });

        await botonSeleccionar.click();

        const botonLista = page.locator('.accion-btn').nth(2);

        await botonLista.waitFor();
        await botonLista.click();

        // abrir select especialidad
        const especialidadInput = page.locator('input[aria-label="Especialidad"]');

        await especialidadInput.click();

        // escribir para filtrar
        await especialidadInput.fill('PERINATOLOGÍA');

        // esperar opción
        const opcion = page.locator('.q-menu .q-item', {
          hasText: 'PERINATOLOGÍA O MEDICINA FETAL'
        }).first();

        await opcion.waitFor();
        await opcion.click();
        await page.waitForTimeout(3000);
        await page.locator('input[aria-label="Fecha Inicial"]').fill(fechaCitaFormateada);
        await page.waitForTimeout(3000);
        await page.locator('input[aria-label="Fecha final"]').fill(fechaCitaFormateada);

        const valor = await page.locator('input[aria-label="Fecha Inicial"]').inputValue();
        console.log(valor);

        await seleccionarCita(page, fechaCita, horaCita);

        await page.waitForTimeout(4000);

        if (centroCosto) {
          // 1️⃣ Ubicar input del select
          const centroCostoInput = page.locator('input[aria-label="Centro de costo"]');
          await centroCostoInput.click();
          
          // 2️⃣ Escribir palabra clave para filtrar
          const palabraClave = centroCosto.split(' ')[0]; 
          await centroCostoInput.fill(palabraClave);

          // 3️⃣ Esperar que aparezcan opciones
          const listaOpciones = page.locator('.q-menu .q-item');
          await listaOpciones.first().waitFor({ state: 'visible' });

          // 4️⃣ Buscar la opción que contenga el texto deseado
          const opcionSeleccionada = listaOpciones.filter({
            hasText: centroCosto // busca coincidencia parcial con todo tu texto
          }).first();

          await opcionSeleccionada.click();
        }

        const tipoInput = page.locator('input[aria-label="Tipo de Atención"]');
        await tipoInput.waitFor();
        await tipoInput.click();
        await tipoInput.fill(tipoAtencion);

        const opcionTipo = page.locator('.q-menu .q-item', {
          hasText: tipoAtencion
        }).first();

        await opcionTipo.waitFor();
        await opcionTipo.click();

        // ===== Clase Orden =====
        const claseOrden = page.locator('input[aria-label="Clase Orden:-"]');

        await claseOrden.click();
        await claseOrden.fill('Normal');

        const opcionClase = page.locator('.q-menu .q-item', {
          hasText: 'Normal'
        }).first();

        await opcionClase.click();

        if (codigoServicio) {

          const serviciosInput = page.locator('input[aria-label="Servicios"]');
          await serviciosInput.click();
          await serviciosInput.fill(codigoServicio);

          // esperar que aparezca el menú con opciones
          const primeraOpcion = page.locator('.q-menu .q-item').first();
          await primeraOpcion.waitFor({ state: 'visible' });

          // seleccionar la opción filtrada
          await primeraOpcion.click();
        }

        // ===== Número de autorización =====
        if (numeroAutorizacion) {

          const autorizacion = page.locator('input[aria-label="N° Autorizacion"]');
          await autorizacion.fill(numeroAutorizacion);

          // esperar a que aparezcan los campos
          const fechaAutorizacion = page.locator('input[aria-label="Fecha Autorizacion:"]');
          await fechaAutorizacion.waitFor({ state: 'visible' });

          const fechaVencimiento = page.locator('input[aria-label="Fecha Vencimiento:"]');

          await fechaAutorizacion.fill(fechaAutorizacionFormateada);
          await fechaVencimiento.fill(fechaVencimientoFormateada);
        }

        // ===== COPAGO =====
        if (copago === true || copago === "true") {

          const checkCopago = page.locator('[aria-label="Copago Propio?"]');
          await checkCopago.click();

          const valorCopagoInput = page.locator('input[aria-label="Valor Copago"]');
          await valorCopagoInput.waitFor({ state: 'visible' });

          const tipoCopagoSelect = page.locator('[aria-label="Tipo copago"]');
          const valorCitaInput = page.locator('input[aria-label="Valor Cita"]');

          await valorCopagoInput.fill(String(valorCopago));
          await valorCitaInput.fill(String(valorCita));

          // abrir selector
          await tipoCopagoSelect.click();

          // seleccionar por texto visible
          const opcionTipoCopago = page.locator('.q-menu .q-item', {
            hasText: tipoCopago
          }).first();

          await opcionTipoCopago.waitFor();
          await opcionTipoCopago.click();

        } else {

          const noCobrar = page.locator('[aria-label="No Cobrar"]');
          await noCobrar.click();

        }

        if (observaciones) {
          const observacionesInput = page.locator('textarea[aria-label="Observaciones:"]');
          await observacionesInput.waitFor({ state: 'visible' });
          await observacionesInput.fill(observaciones);
        }

        if (acompanante || responsable) {
          // abrir pestaña
          const tabAcompanante = page.locator('.q-tab', {
            hasText: 'Acompañante/Responsable'
          });

          await tabAcompanante.click();

          // ===== DATOS ACOMPAÑANTE =====
          if (acompanante) {

            const nombreAcomp = page.locator('input[aria-label="Nombre Acompañante:"]').first();
            const direccionAcomp = page.locator('input[aria-label="Direccion:"]');
            const telefonoAcomp = page.locator('input[aria-label="Teléfono:"]').first();

            await nombreAcomp.fill(acompanante.nombre);
            await direccionAcomp.fill(acompanante.direccion);
            await telefonoAcomp.fill(acompanante.telefono);

            // parentesco (select)
            const parentescoSelect = page.locator('[aria-label="Parentesco"]').first();
            await parentescoSelect.click();

            const opcionParentesco = page.locator('.q-menu .q-item', {
              hasText: acompanante.parentesco
            }).first();

            await opcionParentesco.waitFor({ state: 'visible' });
            await opcionParentesco.click();
          }

          // ===== DATOS RESPONSABLE =====
          if (responsable) {

            const nombreResp = page.locator('input[aria-label="Nombre Acompañante:"]').nth(1);
            const telefonoResp = page.locator('input[aria-label="Teléfono:"]').nth(1);
            const parentescoResp = page.locator('input[aria-label="Parentesco:"]');

            await nombreResp.fill(responsable.nombre);
            await telefonoResp.fill(responsable.telefono);
            await parentescoResp.fill(responsable.parentesco);
          }
        }

        const botonAgendar = page.locator('button', {
          hasText: 'Agendar'
        });

        await botonAgendar.waitFor({ state: 'visible' });
        await botonAgendar.click();

        procesando = false;

       
      } catch (error) {
        console.error("Error en proceso asíncrono:", error);
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
