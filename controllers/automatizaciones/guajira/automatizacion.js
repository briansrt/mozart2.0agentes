import dotenv from "dotenv";
import { Hyperbrowser } from "@hyperbrowser/sdk";
import { chromium } from "playwright-core";
import { guardarResultadoEnCache, obtenerResultadoDeCache } from '../../../utils/memoryCache.js';
import { transformarAutorizacionesGuajira, transformarAutorizacionesEsperanza } from "../../../utils/excel/transformarAutorizaciones.js";
import { generarExcelBuffer } from "../../../utils/excel/escribirExcel.js";
import moment from "moment-timezone";
import { leerExcelDesdeBuffer } from "../../../utils/excel/leerExcel.js";

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
  const { documento, tipoDocumento, tenant } = req.body;

  const profileId = process.env.profileIdGuajiraVALIDOR
  const usuario = process.env.USUARIOGUAJIRAVALIDOR
  const clave = process.env.CLAVEGUAJIRAVALIDOR

  let session, browser, page;
  const cupsPermitidos = new Set([
    "697101",
    "751101",
    "881401",
    "881402",
    "881431",
    "881432",
    "881434",
    "881435",
    "881436",
    "881437",
    "881438",
    "881439",
    "882298",
    "1005774",
    "890250",
    "890250ALR",
    "890250PNA",
    "890350",
    "890350ALR",
    "890350PNA",
    "897011"
  ]);

  const URL_PORTAL =
    "https://portal.colsanitas.com/sso/login?service=https%3A%2F%2Fappcore.colsanitas.com%2FValidadorDerechos%2Fpages%2Fgestion%2FValidacionDerechos.seam%3Fcid%3D2349";

  try {
        session = await client.sessions.create({
          acceptCookies: true,
          saveDownloads: true,
          profile: { id: profileId, persistChanges: false },
        });

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
        await page.waitForTimeout(2000);
        await page.fill("#formaVDGeneral\\:numDocumento", documento);
        await page.waitForTimeout(1000);
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
                  fechaAprobacion:    celdas[3]?.innerText.trim(),
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
              cupsPermitidos.has(a.codigo?.toUpperCase()) &&
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
                  fechaAutorizacion: aut.fechaAprobacion,
                  fechaExpedicion: aut.fechaVigencia, //CAMBIO
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

        // console.log("✅ Fila lista para la tabla:", JSON.stringify(filaTabla, null, 2));

        const filasExcel = transformarAutorizacionesGuajira(filaTabla);
        if (filaTabla.puedeAgendar) {
          const buffer = generarExcelBuffer(filasExcel);
          console.log("filas excel construido: ", filasExcel)

          const contextGlobal = browser.contexts()[0];
          const pageMozartia = await contextGlobal.newPage();

          await pageMozartia.goto(`https://new.app.mozartia.com/${tenant}/login`, {
            waitUntil: "networkidle",
          });

          // elegir email según tenant
          const emailMozart =
            tenant === "cemdiprueba"
              ? process.env.mozartEmailCemdiPrueba
              : process.env.mozartEmail;

          await pageMozartia
            .locator('input[name="email"]')
            .fill(emailMozart);
          await pageMozartia
            .locator('input[name="password"]')
            .fill(process.env.mozartPassword);
          await pageMozartia
            .getByRole("button", { name: /Acceder al Sistema/i })
            .click();

          await pageMozartia.waitForFunction(
            (tenant) => {
              return (
                location.pathname.startsWith(`/${tenant}`) ||
                location.pathname.startsWith("/medical-authorizations")
              );
            },
            tenant,
            { timeout: 60000 },
          );

          await pageMozartia.getByRole("button", { name: /Aceptar/i }).click();

          await pageMozartia.goto(
            `https://new.app.mozartia.com/${tenant}/medical-authorizations`,
            { waitUntil: "networkidle" },
          );

          await pageMozartia
            .getByRole("button", {
              name: /Carga Masiva/i,
            })
            .waitFor({ state: "visible" });

          await pageMozartia
            .getByRole("button", {
              name: /Carga Masiva/i,
            })
            .click();

          const fileInput = pageMozartia.locator(
            'input[type="file"][accept*=".xlsx"]',
          );

          await fileInput.waitFor({ state: "visible" });

          await fileInput.setInputFiles({
            name: "autorizaciones.xlsx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            buffer: buffer,
          });

          const cargarBtn = pageMozartia.getByRole("button", {
            name: /Cargar Archivo/i,
          });

          await pageMozartia
            .locator('button:not([disabled]):has-text("Cargar Archivo")')
            .waitFor({ state: "visible", timeout: 15000 });

          await cargarBtn.click();
          await page.waitForTimeout(2500);
          console.log("✅ Excel subido a Mozart");

        } else {
          console.log("⏭️ Paciente no puede agendar, se omite carga a Mozart:", filaTabla.motivo);
        }


        // if (sesionExpirada) await client.sessions.stop(session.id);

        console.log({
          documento,
          estado: "completado",
          puedeAgendar: filaTabla.puedeAgendar,
          motivo: filaTabla.motivo ?? "",
          datos: filaTabla,
        })

        return res.status(200).json({
          documento,
          estado: "completado",
          puedeAgendar: filaTabla.puedeAgendar,
          motivo: filaTabla.motivo ?? "",
          datos: filaTabla,
        });

      } catch (err) {
        console.error("❌ Error:", err.message);
        return res.status(500).json({
          documento,
          estado: "error",
          puedeAgendar: false,
          motivo: "Error al procesar la solicitud",
          error: err.message,
          timestamp: new Date().toISOString(),
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
  await page.waitForTimeout(2000);

  while (true) {
    await page.waitForSelector('.q-table tbody tr.q-tr', { timeout: 2000 });

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
    await page.waitForTimeout(1000);
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
  const {
    documento, fechaCita, horaCita, centroCosto, codigoServicio, tipoAtencion,
    numeroAutorizacion, fechaAutorizacion, fechaVencimiento, copago, valorCopago,
    tipoCopago, valorCita, observaciones, acompanante, responsable,
    // Campos Mozart
    doctorId, tipo, tenant, pacienteId, especialidad, autorizacionId, sedeId, citaId
  } = req.body;

  const formatearFecha = (f) => {
    if (!f) return f;

    const separador = f.includes('/') ? '/' : '-';
    const partes = f.split(separador);

    if (partes.length !== 3) {
      throw new Error(`Formato de fecha inválido: ${f}`);
    }

    // Si ya está en formato YYYY-MM-DD
    if (partes[0].length === 4) return f;

    const [dia, mes, anio] = partes;
    return `${anio}-${mes}-${dia}`;
  };

  const [
    fechaCitaFormateada,
    fechaAutorizacionFormateada,
    fechaVencimientoFormateada
  ] = [fechaCita, fechaAutorizacion, fechaVencimiento].map(formatearFecha);

  const usuario = process.env.USUARIOGUAJIRA
  const clave = process.env.CLAVEGUAJIRA
  const profileId = process.env.profileIdGuajira

  let session = null;
  let browser = null;
  let procesando = true;

  try {
    // Intentar con el perfil existente
    session = await client.sessions.create({ 
      acceptCookies: true,
      profile: {
        id: profileId,
        persistChanges: true,
      }
    });

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    let context = browser.contexts()[0];
    let page = context.pages()[0];

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

        await page.waitForTimeout(1000);

        // Continuar con el flujo normal
        await page.goto("https://api-test.qrystalos.com/#/ce", {
          waitUntil: "networkidle"
        });

        await page.waitForTimeout(1500);

        await page.goto("https://api-test.qrystalos.com/#/ce/agendamiento", {
          waitUntil: "networkidle"
        });

        console.log("✅ Entró a Agenda correctamente");
        
        await page.waitForTimeout(2000);

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
        await page.waitForTimeout(2000);
        await page.locator('input[aria-label="Fecha Inicial"]').fill(fechaCitaFormateada);
        await page.waitForTimeout(2000);
        await page.locator('input[aria-label="Fecha final"]').fill(fechaCitaFormateada);

        const valor = await page.locator('input[aria-label="Fecha Inicial"]').inputValue();
        console.log(valor);

        const citaEncontrada = await seleccionarCita(page, fechaCita, horaCita);

        if (!citaEncontrada) {
          return res.status(404).json({
            mensaje: "La fecha u hora solicitada no está disponible en Qrystal",
            fechaSolicitada: fechaCita,
            horaSolicitada: horaCita,
            disponible: false
          });
        }

        await page.waitForTimeout(2500);

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
        await page.waitForTimeout(2000);

        console.log("✅ Cita agendada en Cristal exitosamente");
        

        // ─────────────────────────────────────────────
        // 🎵 PASO 2: Agendar en Mozart
        // Solo se ejecuta si Cristal fue exitoso
        // ─────────────────────────────────────────────
        console.log("🎵 Agendando en Mozart...");

        const mozartResponse = await fetch("https://new.api.mozartia.com/api/external/appointment", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.MOZART_API_KEY
          },
          body: JSON.stringify({
            hora: horaCita,
            doctorId,
            tipo,
            tenant,
            pacienteId,
            fecha: fechaCitaFormateada,
            especialidad,
            autorizacionId,
            sedeId,
            citaId,
          })
        });

        if (!mozartResponse.ok) {
          const errorMozart = await mozartResponse.text();
          console.error("❌ Mozart falló:", errorMozart);

          // Cristal quedó agendada, Mozart no — retornar advertencia con detalle
          return res.status(207).json({
            mensaje: "Cita agendada en Cristal pero falló en Mozart",
            cristal: "agendado",
            mozart: "fallido",
            mozartStatus: mozartResponse.status,
            mozartError: errorMozart
          });
        }

        const mozartData = await mozartResponse.json();
        console.log("✅ Cita agendada en Mozart exitosamente");


        procesando = false;

        console.log("Cita agendada exitosamente en Cristal y Mozart")

        return res.status(200).json({
          mensaje: "Cita agendada exitosamente en Cristal y Mozart",
          cristal: "agendado",
          mozart: "agendado",
          mozartData
        });

       
      } catch (error) {
        console.error("❌ Error:", error.message);
        if (!res.headersSent) {
          res.status(500).json({
            mensaje: "Error al agendar la cita",
            error: error.message,
          });
        }
  }finally {
    procesando = false;
    try {
      if (browser) await browser.close();
      if (session) await client.sessions.stop(session.id);
      console.log("✅ Sesión cerrada correctamente");
    } catch (e) {
      console.error("⚠️ Error al cerrar sesión:", e.message);
    }
  }
}


export const ReAgendarCitaGuajiraCristal = async (req, res) => {
  const { fechaAntigua, horaAntigua, nuevaFecha, nuevaHora, observacion, especialidad, pacienteId, tenant, tipo, doctorId, citaIdOriginal } = req.body

  const formatearFecha = (f) => {
    if (!f) return f;

    // Detecta separador automáticamente
    const separador = f.includes('/') ? '/' : '-';

    const partes = f.split(separador);

    // Si ya viene en formato YYYY-MM-DD no tocar
    if (partes[0].length === 4) return f;

    const [dia, mes, anio] = partes;
    return `${anio}-${mes}-${dia}`;
  };

  const [fechaAntiguaInput, nuevaFechaFormateada] =
    [fechaAntigua, nuevaFecha].map(formatearFecha);

  const usuario = process.env.USUARIOGUAJIRA
  const clave = process.env.CLAVEGUAJIRA
  const profileId = process.env.profileIdGuajira

  let session = null;
  let browser = null;
  let procesando = true;

  try {
    // Intentar con el perfil existente
    session = await client.sessions.create({ 
      acceptCookies: true,
      profile: {
        id: profileId,
        persistChanges: true,
      }
    });

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    let context = browser.contexts()[0];
    let page = context.pages()[0];

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

        // Continuar con el flujo normal
        await page.goto("https://api-test.qrystalos.com/#/ce", {
          waitUntil: "networkidle"
        });

        await page.waitForTimeout(3000);

        await page.goto("https://api-test.qrystalos.com/#/ce/agendamiento", {
          waitUntil: "networkidle"
        });

        console.log("✅ Entró a Agenda correctamente");

        await page.waitForTimeout(1500);

        const fechaInput = page.locator('input[aria-label="Fecha"]');
        await fechaInput.fill(fechaAntiguaInput);

        const especialidadInput = page.locator('input[aria-label="Seleccione una especialidad"]');
        await especialidadInput.click();
        await especialidadInput.fill('PERINATOLOGÍA');

        // esperar opción
        const opcion = page.locator('.q-menu .q-item', {
          hasText: 'PERINATOLOGÍA O MEDICINA FETAL'
        }).first();

        await opcion.waitFor();
        await opcion.click();

        await page.waitForTimeout(1500);
        await page.getByRole('button', { name: 'Ocupado' }).click();

        const fila = page.locator('tr.q-tr', {
          has: page.locator('td span', { hasText: horaAntigua })
        });
        await fila.locator('td.cursor-pointer').click();
        await page.waitForTimeout(1000);
        await page.locator('button:has(i.material-icons:text("event_repeat"))').click();
        await page.waitForTimeout(1000);

        await seleccionarCita(page, nuevaFecha, nuevaHora);

        const selectMotivo = page.locator('label:has-text("Motivo Re-programación:") input[role="combobox"]');
        await selectMotivo.waitFor();

        // Hacer click para abrir el dropdown
        await selectMotivo.click();

        // Escribir la opción que queremos seleccionar
        await selectMotivo.fill('Reprogramado por paciente');

        // Esperar que aparezca la opción en la lista y hacer click
        const opcionReprog = page.locator('.q-menu .q-item', {
          hasText: 'Reprogramado por paciente'
        }).first();
        await opcionReprog.waitFor();
        await opcionReprog.click();

        const inputObservacion = page.locator('input[aria-label="Observación"]');
        await inputObservacion.waitFor();
        await inputObservacion.fill(observacion);

        const botonReagendar = page.locator('button:has-text("Re-programar Cita")');
        await botonReagendar.waitFor();
        await botonReagendar.click();
        await page.waitForTimeout(2500);

        console.log("✅ Cita reprogramada correctamente");

        //MOZART REAGENDAMIENTO

        const mozartResponse = await fetch("https://new.api.mozartia.com/api/external/reschedule-appointment", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.MOZART_API_KEY
          },
          body: JSON.stringify({
            hora: nuevaHora,
            doctorId,
            tipo,
            tenant,
            pacienteId,
            fecha: nuevaFechaFormateada,
            especialidad,
            citaIdOriginal,
            motivo: observacion,
            especialidad
          })
        });

        if (!mozartResponse.ok) {
          const errorMozart = await mozartResponse.text();
          console.error("❌ Mozart falló:", errorMozart);

          // Cristal quedó agendada, Mozart no — retornar advertencia con detalle
          return res.status(207).json({
            mensaje: "Cita reagendada en Cristal pero falló en Mozart",
            cristal: "reagendado",
            mozart: "fallido",
            mozartStatus: mozartResponse.status,
            mozartError: errorMozart
          });
        }

        const mozartData = await mozartResponse.json();
        console.log("✅ Cita reagendada en Mozart exitosamente");

        procesando = false;

        console.log("Cita reagendada exitosamente en Cristal y Mozart")

        return res.status(200).json({
          mensaje: "Cita reagendada exitosamente en Cristal y Mozart",
          cristal: "reagendado",
          mozart: "reagendado",
          mozartData
        });

      } catch (error) {
        console.error("❌ Error:", error.message);
        if (!res.headersSent) {
          res.status(500).json({
            mensaje: "Error al reagendar la cita",
            error: error.message,
          });
        }
  }finally {
    procesando = false;
    try {
      if (browser) await browser.close();
      if (session) await client.sessions.stop(session.id);
      console.log("✅ Sesión cerrada correctamente");
    } catch (e) {
      console.error("⚠️ Error al cerrar sesión:", e.message);
    }
  }
}

export const CancelarCitaGuajiraCristal = async (req, res) => {
  const { fecha, hora, observacion, citaId, tenant } = req.body

  const fechaCancelar = (() => {
    if (!fecha) return fecha;

    const separador = fecha.includes('/') ? '/' : '-';
    const partes = fecha.split(separador);

    if (partes.length !== 3) {
      throw new Error(`Formato de fecha inválido: ${fecha}`);
    }

    // Si ya está en formato YYYY-MM-DD
    if (partes[0].length === 4) return fecha;

    const [dia, mes, anio] = partes;
    return `${anio}-${mes}-${dia}`;
  })();

  const usuario = process.env.USUARIOGUAJIRA
  const clave = process.env.CLAVEGUAJIRA
  const profileId = process.env.profileIdGuajira

  let session = null;
  let browser = null;
  let procesando = true;

  try {
    // Intentar con el perfil existente
    session = await client.sessions.create({ 
      acceptCookies: true,
      profile: {
        id: profileId,
        persistChanges: true,
      }
    });

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    let context = browser.contexts()[0];
    let page = context.pages()[0];

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

        // Continuar con el flujo normal
        await page.goto("https://api-test.qrystalos.com/#/ce", {
          waitUntil: "networkidle"
        });

        await page.waitForTimeout(3000);

        await page.goto("https://api-test.qrystalos.com/#/ce/agendamiento", {
          waitUntil: "networkidle"
        });

        console.log("✅ Entró a Agenda correctamente");

        const fechaInput = page.locator('input[aria-label="Fecha"]');
        await fechaInput.fill(fechaCancelar);

        const especialidad = page.locator('input[aria-label="Seleccione una especialidad"]');
        await especialidad.click();
        await especialidad.fill('PERINATOLOGÍA');

        // esperar opción
        const opcion = page.locator('.q-menu .q-item', {
          hasText: 'PERINATOLOGÍA O MEDICINA FETAL'
        }).first();

        await opcion.waitFor();
        await opcion.click();

        await page.waitForTimeout(1500);
        await page.getByRole('button', { name: 'Ocupado' }).click();

        const fila = page.locator('tr.q-tr', {
          has: page.locator('td span', { hasText: hora })
        });
        await fila.locator('td.cursor-pointer').click();
        await page.waitForTimeout(1000);
        await page.locator('button:has(i.material-icons:text("block"))').click();
        await page.waitForTimeout(1000);

        const selectCausa = page.locator('label:has-text("Causas (*)") input[role="combobox"]');
        await selectCausa.waitFor();

        // Hacer click para abrir el dropdown
        await selectCausa.click();

        // Escribir la opción que queremos seleccionar
        await selectCausa.fill('CANCELADA POR PACIENTE');

        // Esperar que aparezca la opción en la lista y hacer click
        const opcionCanc = page.locator('.q-menu .q-item', {
          hasText: 'CANCELADA POR PACIENTE'
        }).first();
        await opcionCanc.waitFor();
        await opcionCanc.click();

        await page.getByRole('textbox', { name: 'Observación' }).fill(observacion);

        const botonReagendar = page.locator('button:has-text("Cancelar Cita")');
        await botonReagendar.waitFor();
        await botonReagendar.click();
        await page.waitForTimeout(2500);

        console.log("✅ Cita Cancelada correctamente");

        //MOZART REAGENDAMIENTO

        const mozartResponse = await fetch("https://new.api.mozartia.com/api/external/cancel-appointment", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.MOZART_API_KEY
          },
          body: JSON.stringify({
            hora,
            citaId,
            notas: observacion,
            tenant
          })
        });

        if (!mozartResponse.ok) {
          const errorMozart = await mozartResponse.text();
          console.error("❌ Mozart falló:", errorMozart);

          // Cristal quedó agendada, Mozart no — retornar advertencia con detalle
          return res.status(207).json({
            mensaje: "Cita cancelada en Cristal pero falló en Mozart",
            cristal: "cancelado",
            mozart: "fallido",
            mozartStatus: mozartResponse.status,
            mozartError: errorMozart
          });
        }

        const mozartData = await mozartResponse.json();
        console.log("✅ Cita cancelada en Mozart exitosamente");

        procesando = false;

        console.log("Cita cancelada exitosamente en Cristal y Mozart")

        return res.status(200).json({
          mensaje: "Cita cancelada exitosamente en Cristal y Mozart",
          cristal: "cancelado",
          mozart: "cancelado",
          mozartData
        });


      } catch (error) {
        console.error("❌ Error:", error.message);
        if (!res.headersSent) {
          res.status(500).json({
            mensaje: "Error al agendar la cita",
            error: error.message,
          });
        }
  }finally {
    procesando = false;
    try {
      if (browser) await browser.close();
      if (session) await client.sessions.stop(session.id);
      console.log("✅ Sesión cerrada correctamente");
    } catch (e) {
      console.error("⚠️ Error al cerrar sesión:", e.message);
    }
  }

}

export const VerificarAsistenciaCitaCristal = async (req, res) => {
  const {fecha, tenant} = req.body

  const fechaCita = (() => {
    if (!fecha) return fecha;

    const separador = fecha.includes('/') ? '/' : '-';
    const partes = fecha.split(separador);

    if (partes.length !== 3) {
      throw new Error(`Formato de fecha inválido: ${fecha}`);
    }

    // Si ya está en formato YYYY-MM-DD
    if (partes[0].length === 4) return fecha;

    const [dia, mes, anio] = partes;
    return `${anio}-${mes}-${dia}`;
  })();
  
  const usuario = process.env.USUARIOGUAJIRA
  const clave = process.env.CLAVEGUAJIRA
  const profileId = process.env.profileIdGuajira

  let session = null;
  let browser = null;
  let procesando = true;

  try {
    // Intentar con el perfil existente
    session = await client.sessions.create({ 
      acceptCookies: true,
      profile: {
        id: profileId,
        persistChanges: true,
      }
    });

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    let context = browser.contexts()[0];
    let page = context.pages()[0];

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

    await page.goto("https://api-test.qrystalos.com/#/autenticarse");

    const selectorInput = 'input[aria-label="Organización *"]';
    await page.click(selectorInput);
    await page.fill(selectorInput, 'Pruebas Clinica esperanza');
    await page.click('div.q-item span:has-text("Pruebas Clinica esperanza")');

    await page.locator('input[aria-label="Usuario *"]').fill(usuario);
    await page.locator('input[aria-label="Clave Secreta *"]').fill(clave);

    await page.click('button:has-text("Continuar")');
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.goto("https://api-test.qrystalos.com/#/ce", { waitUntil: "networkidle" });

        // Continuar con el flujo normal
        await page.goto("https://api-test.qrystalos.com/#/ce", {
          waitUntil: "networkidle"
        });

        await page.waitForTimeout(3000);

        await page.goto("https://api-test.qrystalos.com/#/ce/agendamiento", {
          waitUntil: "networkidle"
        });

        console.log("✅ Entró a Agenda correctamente");

        const fechaInput = page.locator('input[aria-label="Fecha"]');
        await fechaInput.fill(fechaCita);

        const especialidad = page.locator('input[aria-label="Seleccione una especialidad"]');
        await especialidad.click();
        await especialidad.fill('PERINATOLOGÍA');

        // esperar opción
        const opcion = page.locator('.q-menu .q-item', {
          hasText: 'PERINATOLOGÍA O MEDICINA FETAL'
        }).first();

        await opcion.waitFor();
        await opcion.click();

        await page.waitForTimeout(1500);
        await page.getByRole('button', { name: 'Cumplida' }).click();
        await page.waitForTimeout(1000);

        // Seleccionar todas las filas que tengan "Cumplida"
        const citasCumplidas = page.locator('td.q-td.cursor-pointer', {
          hasText: 'Cumplida'
        });

        const totalCitas = await citasCumplidas.count();
        console.log(`Total citas cumplidas encontradas: ${totalCitas}`);

        const cedulas = [];

        for (let i = 0; i < totalCitas; i++) {
          const citas = page.locator('td.q-td.cursor-pointer', { hasText: 'Cumplida' });
          
          await citas.nth(i).click();
          await page.waitForTimeout(1500);

          // Esperar que aparezca la barra de detalle
          const detailBar = page.locator('.cit-detail-bar');
          await detailBar.waitFor({ state: 'visible', timeout: 5000 });
          await page.waitForTimeout(1000);

          // Extraer la cédula — soporta CC, TI, CE, PA, RC, etc.
          const cedulaEl = page.locator('.q-item__label.text-link').first();
          await cedulaEl.waitFor({ timeout: 5000 });
          const textoCedula = (await cedulaEl.innerText()).trim();
          const tipoCedula = textoCedula.split(' ')[0];
          const numeroCedula = textoCedula.replace(/^[A-Z]+\s*/, '').trim();
          const celdaCita = citas.nth(i);
          const textoEPS = await celdaCita.locator('small b').nth(0).innerText();
          const textoPlan = await celdaCita.locator('small b').nth(1).innerText();

          const fechaEl = page.locator('.q-item__label.cit-detail-value.text-bold.text-negative').first();
          await fechaEl.waitFor({ timeout: 5000 });
          const textoFecha = (await fechaEl.innerText()).trim();
          const fechaCita = textoFecha.split(' - ')[0].trim();
          const solofecha = fechaCita.split(' ')[0];

          cedulas.push({ 
            tipo: tipoCedula, 
            numero: numeroCedula,
            eps: textoEPS.trim(),
            plan: textoPlan.trim(),
            fechaCita: solofecha
          });


          // Cerrar usando el botón con ícono "close" dentro de la barra de detalle
          const btnCerrar = detailBar.locator('button:has(i.material-icons:text("close"))');
          await btnCerrar.waitFor({ state: 'visible', timeout: 5000 });
          await btnCerrar.click();

          // Esperar que la barra se cierre
          await detailBar.waitFor({ state: 'hidden', timeout: 5000 });
          await page.waitForTimeout(1000);
        }

        console.log('Cédulas extraídas:', cedulas);

        procesando = false;

        const contextGlobal = browser.contexts()[0];
        const pageMozartia = await contextGlobal.newPage();

          await pageMozartia.goto(`https://new.app.mozartia.com/${tenant}/login`, {
            waitUntil: "networkidle",
          });

          // elegir email según tenant
          const emailMozart =
            tenant === "cemdiprueba"
              ? process.env.mozartEmailCemdiPrueba
              : process.env.mozartEmail;

          await pageMozartia
            .locator('input[name="email"]')
            .fill(emailMozart);
          await pageMozartia
            .locator('input[name="password"]')
            .fill(process.env.mozartPassword);
          await pageMozartia
            .getByRole("button", { name: /Acceder al Sistema/i })
            .click();

          await pageMozartia.waitForFunction(
            (tenant) => {
              return (
                location.pathname.startsWith(`/${tenant}`) ||
                location.pathname.startsWith("/patients")
              );
            },
            tenant,
            { timeout: 60000 },
          );

          await pageMozartia.getByRole("button", { name: /Aceptar/i }).click();

          await pageMozartia.goto(
            `https://new.app.mozartia.com/${tenant}/patients`,
            { waitUntil: "networkidle" },
          );

          function obtenerNombreTab(eps, plan) {
            const texto = (eps + ' ' + plan).toLowerCase();
            if (texto.includes('particular')) return 'Particular';
            if (texto.includes('sanitas') && !texto.includes('colsanitas')) return 'Sanitas';
            if (texto.includes('colsanitas')) return 'Colsanitas';
            if (texto.includes('nueva eps') || texto.includes('nueva-eps')) return 'Nueva Eps';
            if (texto.includes('fideicomisos')) return 'Fideicomisos S.A';
            if (texto.includes('coomeva')) return 'Coomeva';
            return null; // Si no coincide, buscar sin filtrar plan
          }

          for (const paciente of cedulas) {
            console.log(`\nProcesando: ${paciente.tipo} ${paciente.numero} - ${paciente.eps} - Fecha: ${paciente.fechaCita}`);

            try {
              await pageMozartia.goto(`https://new.app.mozartia.com/${tenant}/patients`, {
                waitUntil: "networkidle",
              });
              await pageMozartia.waitForTimeout(1500);

              // Función helper para buscar por cédula
              const buscarPaciente = async () => {
                const input = pageMozartia.locator('input[placeholder*="Nombre, email, teléfono..."]');
                await input.waitFor({ state: 'visible', timeout: 5000 });
                await input.clear();
                await input.fill(paciente.numero);
                await pageMozartia.waitForTimeout(500);
                await pageMozartia.locator('button[title="Buscar pacientes"]').click();
                await pageMozartia.waitForLoadState('networkidle');
                await pageMozartia.waitForTimeout(2000);

                const filas = await pageMozartia.locator('tbody tr').count();
                console.log(`  🔍 Filas encontradas: ${filas}`);
                return filas;
              };

              // Seleccionar tab del plan
              const nombreTab = obtenerNombreTab(paciente.eps, paciente.plan);
              if (nombreTab) {
                const tabBtn = pageMozartia.locator(`nav button`, { hasText: nombreTab }).first();
                const tabVisible = await tabBtn.isVisible();
                if (tabVisible) {
                  await tabBtn.click();
                } else {
                  await pageMozartia.locator('select').selectOption({ label: nombreTab });
                }
                await pageMozartia.waitForTimeout(1000);
                console.log(`  Tab EPS seleccionado: ${nombreTab}`);
              }

              // Seleccionar sub-tab de plan (Perinatología, Mamografías, etc.)
              await pageMozartia.waitForTimeout(800);
              const subTabPerinat = pageMozartia.locator('nav button', { hasText: /Perinatolog/i }).first();
              const haySubTab = await subTabPerinat.isVisible();
              if (haySubTab) {
                await subTabPerinat.click();
                await pageMozartia.waitForTimeout(800);
                console.log(`  Sub-tab seleccionado: Plan Perinatología`);
              } else {
                // Intentar con select mobile
                const selectSubTab = pageMozartia.locator('select option', { hasText: /Perinatolog/i });
                const haySelectSubTab = await selectSubTab.count() > 0;
                if (haySelectSubTab) {
                  await pageMozartia.locator('select').last().selectOption({ label: /Perinatolog/i });
                  await pageMozartia.waitForTimeout(800);
                  console.log(`  Sub-tab (select) seleccionado: Plan Perinatología`);
                }
              }

              // Primera búsqueda en el tab del plan
              let filas = await buscarPaciente();

              // Fallback: si no hay resultados, buscar en tab Pacientes
              if (filas === 0) {
                console.warn(`  ⚠️ No encontrado en tab ${nombreTab}, buscando sin filtro...`);
                await pageMozartia.locator(`nav button`, { hasText: 'Pacientes' }).first().click();
                await pageMozartia.waitForTimeout(1000);
                filas = await buscarPaciente();
              }

              if (filas === 0) {
                console.warn(`  ⚠️ Paciente ${paciente.numero} no encontrado en ningún tab`);
                continue;
              }

              // Click en agenda del primer resultado
              const btnAgenda = pageMozartia.locator('button[title="Ver agenda del paciente"]').first();
              await btnAgenda.waitFor({ state: 'visible', timeout: 8000 });
              await btnAgenda.click();
              await pageMozartia.waitForTimeout(1500);

              // Ir a pestaña Agendadas
              const tabAgendadas = pageMozartia.locator('button', { hasText: /Agendadas/i }).first();
              await tabAgendadas.waitFor({ state: 'visible', timeout: 5000 });
              await tabAgendadas.click();
              await pageMozartia.waitForTimeout(1000);

              // Verificar si hay citas agendadas
              const sinCitas = pageMozartia.locator('h3', { hasText: 'No hay citas agendadas' });
              const estaVacio = await sinCitas.isVisible();

              if (estaVacio) {
                console.warn(`  ⚠️ Sin citas agendadas para ${paciente.tipo} ${paciente.numero}`);
                continue;
              }

              // Buscar la cita que coincida con la fecha extraída
              const todasLasCitas = pageMozartia.locator('.border.border-gray-200.rounded-xl');
              const totalCitasMozart = await todasLasCitas.count();
              console.log(`  📅 Buscando cita del ${paciente.fechaCita} entre ${totalCitasMozart} cita(s)`);

              let encontrada = false;
              for (let j = 0; j < totalCitasMozart; j++) {
                const citaMozart = todasLasCitas.nth(j);
                const textoCita = await citaMozart.innerText();

                if (textoCita.includes(paciente.fechaCita)) {
                  const btnCompletar = citaMozart.locator('button[title="Marcar como completada"]');
                  await btnCompletar.waitFor({ state: 'visible', timeout: 5000 });
                  await btnCompletar.click();
                  await pageMozartia.waitForTimeout(1000);
                  const btnConfirmar = pageMozartia.locator('button', { hasText: 'Marcar como Completada' }).last();

                  await btnConfirmar.waitFor({ state: 'visible', timeout: 5000 });
                  await btnConfirmar.click();
                  await page.waitForTimeout(1000);
                  encontrada = true;
                  console.log(`  ✅ Completada cita del ${paciente.fechaCita}: ${paciente.tipo} ${paciente.numero}`);
                  break;
                }
              }

              if (!encontrada) {
                console.warn(`  ⚠️ No se encontró cita del ${paciente.fechaCita} para ${paciente.numero}`);
              }

            } catch (err) {
              console.error(`  ❌ Error con ${paciente.tipo} ${paciente.numero}:`, err.message);
            }
          }

          console.log('\n=== Proceso finalizado ===');
          console.log(`Total procesados: ${cedulas.length}`);



      } catch (error) {
        console.error("❌ Error:", error.message);
        if (!res.headersSent) {
          res.status(500).json({
            mensaje: "Error al consultar el estado de la cita",
            error: error.message,
          });
        }
  }finally {
    procesando = false;
    try {
      if (browser) await browser.close();
      if (session) await client.sessions.stop(session.id);
      console.log("✅ Sesión cerrada correctamente");
    } catch (e) {
      console.error("⚠️ Error al cerrar sesión:", e.message);
    }
  }

}

export const descargarAutorizacionEsperanza = async (req, res) => {
  const { tenant } = req.body;
  const archivoExcel = req.file;

  if (!archivoExcel) {
    return res.status(400).json({
      mensaje: "No se recibió archivo Excel",
    });
  }

  try {
    session = await client.sessions.create({ acceptCookies: true });
    console.log("preview: ", session.liveUrl);

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    const context = browser.contexts()[0];
    page = context.pages()[0];

    const bufferExcel = archivoExcel.buffer;
    const dataOriginal = leerExcelDesdeBuffer(bufferExcel);

    // ===== Procesar Excel =====
    const dataTransformada = transformarAutorizacionesEsperanza(dataOriginal);

    
    const personasSubidas = dataTransformada.map((row) => ({
      cedula: row["Cédula *"],
      nombre: row["Nombres *"],
      servicio: row["Servicio *"],
      autorizacion: row["Número de Autorización"],
    }));

    if (personasSubidas.length === 0) {
      return res.status(200).json({
        mensaje: "No se encontraron registros para subir",
        personas: [],
        total: 0,
      });
    }

    const bufferTransformado = generarExcelBuffer(dataTransformada);
    console.log("✅ Excel transformado generado en memoria");

    /* ======================
       LOGIN MOZART
    ====================== */
    contextGlobal = browser.contexts()[0];
    pageMozartia = await contextGlobal.newPage();

    await pageMozartia.goto(`https://new.app.mozartia.com/${tenant}`, {
      waitUntil: "networkidle",
    });

    await pageMozartia
      .locator('input[name="email"]')
      .fill(process.env.mozartEmailCemdiPrueba);
    await pageMozartia
      .locator('input[name="password"]')
      .fill(process.env.mozartPassword);
    await pageMozartia
      .getByRole("button", { name: /Acceder al Sistema/i })
      .click();

    await pageMozartia.waitForFunction(
      (tenant) => {
        return (
          location.pathname.startsWith(`/${tenant}`) ||
          location.pathname.startsWith("/medical-authorizations")
        );
      },
      tenant,
      { timeout: 60000 }
    );

    await pageMozartia.getByRole("button", { name: /Aceptar/i }).click();

    await pageMozartia.goto(
      `https://new.app.mozartia.com/${tenant}/medical-authorizations`,
      { waitUntil: "networkidle" }
    );

    await pageMozartia
      .getByRole("button", { name: /Carga Masiva/i })
      .waitFor({ state: "visible" });

    await pageMozartia
      .getByRole("button", { name: /Carga Masiva/i })
      .click();

    const fileInput = pageMozartia.locator(
      'input[type="file"][accept*=".xlsx"]'
    );
    await fileInput.waitFor({ state: "visible" });

    await fileInput.setInputFiles({
      name: "autorizaciones.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: bufferTransformado,
    });

    await pageMozartia
      .locator('button:not([disabled]):has-text("Cargar Archivo")')
      .waitFor({ state: "visible", timeout: 15000 });

    await pageMozartia
      .getByRole("button", { name: /Cargar Archivo/i })
      .click();

    await page.waitForTimeout(2000);

    console.log("✅ Excel subido a Mozart");

    // ✅ Respuesta final con las personas procesadas
    return res.status(200).json({
      mensaje: "Autorizaciones cargadas exitosamente",
      total: personasSubidas.length,
      personas: personasSubidas,
    });

  } catch (error) {
    console.error("Error en el proceso:", error);
    if (!res.headersSent) {
      res.status(500).json({
        mensaje: "Error durante el proceso",
        error: error.message,
      });
    }
  } finally {
    console.log("🔒 Cerrando sesión Hyperbrowser...");
    try {
      if (browser) await browser.close();
    } catch (e) {
      console.log("Error cerrando browser:", e.message);
    }
    console.log("✅ Sesión cerrada correctamente");
  }
};

export const verificarCita = async (req, res) => {
  const { fecha, tenant } = req.body

  const fechaCita = (() => {
    if (!fecha) return fecha;

    const separador = fecha.includes('/') ? '/' : '-';
    const partes = fecha.split(separador);

    if (partes.length !== 3) {
      throw new Error(`Formato de fecha inválido: ${fecha}`);
    }

    // Si ya está en formato YYYY-MM-DD
    if (partes[0].length === 4) return fecha;

    const [dia, mes, anio] = partes;
    return `${anio}-${mes}-${dia}`;
  })();
  
  const usuario = process.env.USUARIOGUAJIRA
  const clave = process.env.CLAVEGUAJIRA
  const profileId = process.env.profileIdGuajira

  let session = null;
  let browser = null;
  let procesando = true;

  try {
    // Intentar con el perfil existente
    session = await client.sessions.create({ 
      acceptCookies: true,
      profile: {
        id: profileId,
        persistChanges: true,
      }
    });

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    let context = browser.contexts()[0];
    let page = context.pages()[0];

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

    await page.goto("https://api-test.qrystalos.com/#/autenticarse");

    const selectorInput = 'input[aria-label="Organización *"]';
    await page.click(selectorInput);
    await page.fill(selectorInput, 'Pruebas Clinica esperanza');
    await page.click('div.q-item span:has-text("Pruebas Clinica esperanza")');

    await page.locator('input[aria-label="Usuario *"]').fill(usuario);
    await page.locator('input[aria-label="Clave Secreta *"]').fill(clave);

    await page.click('button:has-text("Continuar")');
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.goto("https://api-test.qrystalos.com/#/ce", { waitUntil: "networkidle" });

        // Continuar con el flujo normal
        await page.goto("https://api-test.qrystalos.com/#/ce", {
          waitUntil: "networkidle"
        });

        await page.waitForTimeout(3000);

        await page.goto("https://api-test.qrystalos.com/#/ce/agendamiento", {
          waitUntil: "networkidle"
        });

        console.log("✅ Entró a Agenda correctamente");

        const fechaInput = page.locator('input[aria-label="Fecha"]');
        await fechaInput.fill(fechaCita);

        const especialidad = page.locator('input[aria-label="Seleccione una especialidad"]');
        await especialidad.click();
        await especialidad.fill('PERINATOLOGÍA');

        // esperar opción
        const opcion = page.locator('.q-menu .q-item', {
          hasText: 'PERINATOLOGÍA O MEDICINA FETAL'
        }).first();

        await opcion.waitFor();
        await opcion.click();

        await page.waitForTimeout(1500);
        await page.getByRole('button', { name: 'Ocupado' }).click();
        await page.waitForTimeout(1000);

        // Seleccionar todas las filas que tengan "Ocupado"
        const citasCumplidas = page.locator('td.q-td.cursor-pointer.bg-red-2');

        const totalCitas = await citasCumplidas.count();
        console.log(`Total citas Ocupados encontradas: ${totalCitas}`);

        const cedulas = [];

        for (let i = 0; i < totalCitas; i++) {
          const citas = page.locator('td.q-td.cursor-pointer.bg-red-2');
          
          await citas.nth(i).click();
          await page.waitForTimeout(1500);

          // Esperar que aparezca la barra de detalle
          const panel = page.locator('.cit-detail-scroll');
          await panel.waitFor({ state: 'visible', timeout: 8000 });

          // Cédula: busca el div con clase text-link dentro de cit-detail-bar
          const cedulaEl = panel.locator('.q-item__label.text-link').first();
          await cedulaEl.waitFor({ timeout: 5000 });
          const textoCedula = (await cedulaEl.innerText()).trim();
          const tipoCedula = textoCedula.split(' ')[0];       // "CC"
          const numeroCedula = textoCedula.split(' ')[1];     // "1120748866"

          // Fecha: busca el div con cit-detail-value text-bold text-negative
          const fechaEl = panel.locator('.q-item__label.cit-detail-value.text-bold.text-negative').first();
          await fechaEl.waitFor({ timeout: 5000 });
          const textoFecha = (await fechaEl.innerText()).trim();
          const solofecha = textoFecha.split(' ')[0];          // "08/04/2026"
          const horacita = textoFecha.split(' ')[1];           // "16:10"
          const estado = textoFecha.split(' - ')[1];           // "No Asistio"

          // Duración: busca el div con text-green-10
          const duracionEl = panel.locator('.q-item__label.cit-detail-caption', { hasText: 'Duración' })
            .locator('..') // sube al q-item__section
            .locator('.q-item__label.cit-detail-value');
            
          const duracion = (await duracionEl.innerText()).trim();

          // Servicio: busca el span con el nombre dentro del card section
          const servicioEl = panel.locator('.q-item__label.ellipsis span.text-weight-medium').nth(1);
          await servicioEl.waitFor({ timeout: 5000 });
          const servicio = (await servicioEl.innerText()).trim(); // "ECOGRAFIA OBSTETRICA TRANSABDOMINAL"

          // Modalidad
          const modalidadEl = panel.locator('.q-item__label.cit-detail-caption', { hasText: 'Modalidad' })
            .locator('..')
            .locator('.q-item__label.cit-detail-value');

          const modalidad = (await modalidadEl.innerText()).trim().split('/')[0].trim(); // "Presencial"

          // Doctor
          const doctorEl = panel.locator('.q-item__label.cit-detail-caption', { hasText: 'Profesional' })
            .locator('..')
            .locator('.q-item__label.ellipsis.cit-detail-value.text-bold');

          const doctor = (await doctorEl.innerText()).trim(); // "MARIA MARGARITA MAZZA RAPAGÑA"

          // Sede
          const sedeEl = panel.locator('.q-item__label.cit-detail-caption', { hasText: 'Sede del Paciente' })
            .locator('..')
            .locator('.q-item__label.cit-detail-value');

          const sede = (await sedeEl.innerText()).trim().split(' - ')[1].trim(); // "CLINICA ESPERANZA SAS BIC"

          cedulas.push({ 
            tipo: tipoCedula, 
            numero: numeroCedula,
            fechaCita: solofecha,
            horaCita: horacita,
            estadoCita: estado,
            duracion: duracion,
            servicio: servicio,
            modalidad: modalidad,
            doctor: doctor,
            sede: sede
          });


          // Cerrar usando el botón con ícono "close" dentro de la barra de detalle
          const btnCerrar = page.locator('.cit-detail-bar button').last();
          await btnCerrar.waitFor({ state: 'visible', timeout: 5000 });
          await btnCerrar.click();

          // Esperar que el panel se cierre
          await panel.waitFor({ state: 'hidden', timeout: 5000 });
          await page.waitForTimeout(800);
        }

        console.log('Cédulas extraídas:', cedulas);
        procesando = false;

        let mozartDataDoctor = null;
        try {
          const mozartResponseDoctor = await fetch("https://new.api.mozartia.com/api/external/doctors", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": process.env.MOZART_API_KEY
            },
            body: JSON.stringify({
              tenant: "clinicaesperanza",
              especialidad: "Perinatología"
            })
          });
          mozartDataDoctor = await mozartResponseDoctor.json();
        } catch (error) {
          console.error("Error fetch Mozart para doctor:", error.message);
        }

        const agendamientos = [];

        for (const paciente of cedulas) {
          try {
            const mozartResponsePatient = await fetch("https://new.api.mozartia.com/api/external/patient-info", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": process.env.MOZART_API_KEY
              },
              body: JSON.stringify({
                tenant: "clinicaesperanza",
                identificacion: paciente.numero
              })
            });

            const mozartDataPatient = await mozartResponsePatient.json();
            
            // Fecha en formato YYYY-MM-DD
            const [dia, mes, anio] = paciente.fechaCita.split('/');
            const fechaFormateada = `${anio}-${mes}-${dia}`;

            const duracionNum = paciente.duracion === 'No definido' || !paciente.duracion
              ? 20
              : parseInt(paciente.duracion);

            const autorizacionEncontrada = mozartDataPatient.data.autorizaciones?.find(a => 
              a.agendada === false &&
              a.activo === true &&
              a.estaVigente === true &&
              a.servicio.toUpperCase().includes(paciente.servicio.toUpperCase())
            );

            const doctorEncontrado = mozartDataDoctor.data.doctores?.find(d => 
              d.nombre.toUpperCase().includes(paciente.doctor.toUpperCase()) ||
              paciente.doctor.toUpperCase().includes(d.nombre.toUpperCase())
            );

            const agendamiento = {
              tenant: "clinicaesperanza",
              pacienteId: mozartDataPatient.data.paciente.id,
              doctorId: doctorEncontrado?.id ?? null,
              autorizacionId: autorizacionEncontrada?.id ?? null,
              fecha: fechaFormateada,
              hora: paciente.horaCita,
              tipo: paciente.modalidad,
              duracion: duracionNum,
              especialidad: "Perinatología"
            };

            if (!agendamiento.pacienteId || !agendamiento.doctorId || !agendamiento.autorizacionId) {
              console.warn(`⚠️ Skipping agendamiento para ${paciente.numero} - faltan datos:`, {
                pacienteId: agendamiento.pacienteId,
                doctorId: agendamiento.doctorId,
                autorizacionId: agendamiento.autorizacionId
              });
              continue;
            }

            try {
              const mozartResponseAppointment = await fetch("https://new.api.mozartia.com/api/external/appointment", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-api-key": process.env.MOZART_API_KEY
                },
                body: JSON.stringify(agendamiento)
              });

              const mozartDataAppointment = await mozartResponseAppointment.json();

              if (mozartDataAppointment.success) {
                console.log(`✅ Cita agendada para ${paciente.numero}:`, mozartDataAppointment);
              } else {
                console.warn(`⚠️ Error al agendar para ${paciente.numero}:`, mozartDataAppointment);
              }

              agendamientos.push({ paciente: paciente.numero, ...agendamiento, respuesta: mozartDataAppointment });

            } catch (error) {
              console.error(`❌ Error fetch agendamiento para ${paciente.numero}:`, error.message);
            }

          } catch (error) {
            console.error(`Error fetch Mozart para ${paciente.numero}:`, error.message);
          }

          
        }

        
        } catch (error) {
        console.error("❌ Error:", error.message);
        if (!res.headersSent) {
          res.status(500).json({
            mensaje: "Error al consultar el estado de la cita",
            error: error.message,
          });
        }
  }finally {
    procesando = false;
    try {
      if (browser) await browser.close();
      if (session) await client.sessions.stop(session.id);
      console.log("✅ Sesión cerrada correctamente");
    } catch (e) {
      console.error("⚠️ Error al cerrar sesión:", e.message);
    }
  }
}

export const disponibilidadQrystalMozart = async (req, res) => {
  const { tenant } = req.body
  
  const usuario = process.env.USUARIOGUAJIRA
  const clave = process.env.CLAVEGUAJIRA
  const profileId = process.env.profileIdGuajira

  let session = null;
  let browser = null;
  let procesando = true;

  try {
    // Intentar con el perfil existente
    session = await client.sessions.create({ 
      acceptCookies: true,
      profile: {
        id: profileId,
        persistChanges: true,
      }
    });

    browser = await chromium.connectOverCDP(session.wsEndpoint);
    let context = browser.contexts()[0];
    let page = context.pages()[0];

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

    await page.goto("https://api-test.qrystalos.com/#/autenticarse");

    const selectorInput = 'input[aria-label="Organización *"]';
    await page.click(selectorInput);
    await page.fill(selectorInput, 'Pruebas Clinica esperanza');
    await page.click('div.q-item span:has-text("Pruebas Clinica esperanza")');

    await page.locator('input[aria-label="Usuario *"]').fill(usuario);
    await page.locator('input[aria-label="Clave Secreta *"]').fill(clave);

    await page.click('button:has-text("Continuar")');
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.goto("https://api-test.qrystalos.com/#/ce", { waitUntil: "networkidle" });

        // Continuar con el flujo normal
        await page.goto("https://api-test.qrystalos.com/#/ce", {
          waitUntil: "networkidle"
        });

        await page.waitForTimeout(3000);

        await page.goto("https://api-test.qrystalos.com/#/ce/agendamiento", {
          waitUntil: "networkidle"
        });

        console.log("✅ Entró a Agenda correctamente");

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
        await page.waitForTimeout(2000);

        const fechaInicial = await page.locator('input[aria-label="Fecha Inicial"]').inputValue();
        const fechaFinal = moment(fechaInicial).add(1, 'month').format('YYYY-MM-DD');

        const inputFechaFinal = page.locator('input[aria-label="Fecha final"]');
        await inputFechaFinal.fill(fechaFinal);

        await page.waitForTimeout(1000);


        // Extraer datos de todas las páginas
        const extraerDatosTabla = async (page) => {
          return await page.evaluate(() => {
            const filas = document.querySelectorAll('.q-table tbody tr');
            const datos = [];
            filas.forEach(fila => {
              const celdas = fila.querySelectorAll('td span.cursor-pointer');
              if (celdas.length > 0) {
                datos.push({
                  dia: celdas[1]?.innerText?.trim(),
                  fecha: celdas[2]?.innerText?.trim(),
                });
              }
            });
            return datos;
          });
        };

        const todasLasCitas = [];

        while (true) {
          await page.waitForTimeout(1000);
          const datos = await extraerDatosTabla(page);
          todasLasCitas.push(...datos);

          const btnSiguiente = page.locator('button[aria-label="Próxima página"]');
          const estaDeshabilitado = await btnSiguiente.getAttribute('disabled');

          if (estaDeshabilitado !== null) {
            console.log("✅ Se llegó a la última página");
            break;
          }

          await btnSiguiente.click();
        }

        // Si hay menos de 10 citas, ampliar a 2 meses
        if (todasLasCitas.length < 5) {
          console.log(`⚠️ Poca disponibilidad (${todasLasCitas.length} citas), ampliando a 2 meses...`);
          todasLasCitas.length = 0; // limpiar

          fechaFinal = moment(fechaInicial).add(2, 'months').format('YYYY-MM-DD');
          await inputFechaFinal.fill(fechaFinal);
          await page.waitForTimeout(1000);

          while (true) {
            await page.waitForTimeout(1000);
            const datos = await extraerDatosTabla(page);
            todasLasCitas.push(...datos);

            const btnSiguiente = page.locator('button[aria-label="Próxima página"]');
            const estaDeshabilitado = await btnSiguiente.getAttribute('disabled');

            if (estaDeshabilitado !== null) {
              console.log("✅ Se llegó a la última página (2 meses)");
              break;
            }

            await btnSiguiente.click();
          }
        }

        console.log("📅 Total citas encontradas:", todasLasCitas.length);
        console.log("disponibilidad: ", todasLasCitas)

        let mozartDataDoctor = null;
        try {
          const mozartResponseDoctor = await fetch("https://new.api.mozartia.com/api/external/availability", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": process.env.MOZART_API_KEY
            },
            body: JSON.stringify({
              tenant: "clinicaesperanza",
              doctorId: "697c9be4fedccd012168bda3",
              especialidad: "Perinatología"
            })
          });
          mozartDataDoctor = await mozartResponseDoctor.json();
        } catch (error) {
          console.error("Error fetch Mozart para doctor:", error.message);
        }

        } catch (error) {
        console.error("❌ Error:", error.message);
        if (!res.headersSent) {
          res.status(500).json({
            mensaje: "Error al consultar el estado de la cita",
            error: error.message,
          });
        }
      }
}