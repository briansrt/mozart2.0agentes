import dotenv from "dotenv";
import { Hyperbrowser } from "@hyperbrowser/sdk";
import { chromium } from "playwright-core";
import moment from "moment-timezone";
import fetch from "node-fetch";

// Polyfills manuales para pdfjs-dist (sin necesitar canvas)
if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor() { this.a=1;this.b=0;this.c=0;this.d=1;this.e=0;this.f=0; }
  };
}
if (!globalThis.ImageData) {
  globalThis.ImageData = class ImageData {
    constructor(w, h) { this.width=w; this.height=h; this.data=new Uint8ClampedArray(w*h*4); }
  };
}
if (!globalThis.Path2D) {
  globalThis.Path2D = class Path2D {};
} 

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

dotenv.config();


const client = new Hyperbrowser({
  apiKey: process.env.HYPERBROWSER_API_KEY,
});


export const AutorizacionEnfasoInicial = async (req, res) => {
  const { usuario, clave, documento } = req.body;

  try {
    // 1️⃣ Crear un perfil nuevo
    const profile = await client.profiles.create({
      name: `enfaso-${usuario}`, // Nombre único por usuario
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
          "https://portal.colsanitas.com/sso/login?service=https%3A%2F%2Fappcore.colsanitas.com%2FValidadorDerechos%2Fpages%2Fgestion%2FValidacionDerechos.seam",
        );

        await page.waitForSelector("#username");

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
                "https://appcore.colsanitas.com/ValidadorDerechos/pages/gestion/ValidacionDerechos.seam",
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
};

export const detectarSesionExpiradaEnfaso = async (page) => {
  try {
    // Esperar a que cargue algo estable
    await page.waitForLoadState("domcontentloaded");

    const urlActual = page.url();

    // 1️⃣ Si la URL volvió al login
    if (urlActual.includes("/sso/login")) {
      console.log("🔎 Detectado por URL de login");
      return true;
    }

    // 2️⃣ Si el formulario de login está visible
    const inputUsuario = page.locator("input[name='username']");
    if (await inputUsuario.isVisible().catch(() => false)) {
      console.log("🔎 Detectado por campo username visible");
      return true;
    }

    // 3️⃣ Si existe mensaje típico de sesión expirada
    const textoSesionExpirada = page.locator("text=/sesión expirada|session expired|vuelva a iniciar sesión/i");
    if (await textoSesionExpirada.first().isVisible().catch(() => false)) {
      console.log("🔎 Detectado por mensaje de sesión expirada");
      return true;
    }

    // 4️⃣ Si la página quedó en blanco o error inesperado
    const bodyVacio = await page.evaluate(() => {
      return !document.body || document.body.innerText.trim().length === 0;
    });

    if (bodyVacio) {
      console.log("🔎 Detectado por body vacío");
      return true;
    }

    // Si no se detectó nada
    return false;

  } catch (error) {
    console.log("⚠️ Error verificando sesión, asumimos expirada:", error.message);
    return true; // Más seguro asumir expirada si algo falla
  }
};  

export const AutorizacionEnfaso = async (req, res) => {
  const { tipoConsulta, tipoDocumento, documento, numAutorizacion } = req.body;

  const usuario= process.env.USUARIOENFASO
  const clave= process.env.CLAVEENFASO
  const profileId = process.env.PROFILEIDENFASO
  
  let session = null;
  let browser = null;

  try {
    // Intentar con el perfil existente
    let session = await client.sessions.create({ 
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
          "https://portal.colsanitas.com/sso/login?service=https%3A%2F%2Fappcore.colsanitas.com%2FValidadorDerechos%2Fpages%2Fgestion%2FValidacionDerechos.seam",
          { waitUntil: 'networkidle' }
        );

        const sesionExpirada = await detectarSesionExpiradaEnfaso(page);

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
            "https://portal.colsanitas.com/sso/login?service=https%3A%2F%2Fappcore.colsanitas.com%2FValidadorDerechos%2Fpages%2Fgestion%2FValidacionDerechos.seam"
          );

          // Re-login
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

          console.log("✅ Perfil renovado con nueva sesión");
        }

        // Continuar con el flujo normal

        // =============================
        // SELECCIÓN SEGÚN tipoConsulta
        // =============================

        let resultado = null;

        if (tipoConsulta === "documento") {
          console.log("Consulta por DOCUMENTO");

          const radioLabel = page.locator("label", {
            hasText: "Tipo y Num Identificación",
          });
          await radioLabel.waitFor({ state: "visible", timeout: 90000 });
          await radioLabel.click();

          await page.waitForTimeout(2000);

          await page
            .locator("#formaVDGeneral\\:selectOneTipoDoc")
            .selectOption({ label: tipoDocumento });

          await page.fill("#formaVDGeneral\\:numDocumento", documento);

          await page.locator("#formaVDGeneral\\:j_id77").click();
          await page.waitForTimeout(3000);

          // 1️⃣ Seleccionar "Todas" en Compañía
          await page
            .locator("#formaVDGeneral\\:selectOneCiaId")
            .selectOption({ label: "Todas" });
          await page.waitForTimeout(1000);

          // Buscar opciones EPS o COLSANITAS
          const opciones = page.locator(
            "#formaVDGeneral\\:selectOnePlanFam label",
          );

          let tipoEntidad = null;

          for (let i = 0; i < (await opciones.count()); i++) {
            const texto = await opciones.nth(i).innerText();

            if (texto.includes("EPS")) {
              tipoEntidad = "EPS";
              console.log("Seleccionando EPS");
              await opciones.nth(i).click();
              break;
            }

            if (texto.includes("COLSANITAS")) {
              tipoEntidad = "COLSANITAS";
              console.log("Seleccionando COLSANITAS");
              await opciones.nth(i).click();
              break;
            }
          }

          if (!tipoEntidad) {
            throw new Error(
              "No se encontró ni EPS ni COLSANITAS en las opciones",
            );
          }

          await page.locator("#formaVDGeneral\\:btnConsultarUsuario").click();
          await page.waitForSelector("#info-usuario", { timeout: 30000 });

          const datosUsuario = await page.evaluate(() => {
            const contenedor = document.querySelector("#info-usuario");
            if (!contenedor) return null;

            const obtenerValor = (labelTexto) => {
              const labels = Array.from(contenedor.querySelectorAll("label"));
              const label = labels.find((l) =>
                l.innerText.trim().includes(labelTexto),
              );
              if (!label) return null;

              const datoDiv = label.parentElement.querySelector(".info-dato");
              return datoDiv ? datoDiv.innerText.trim() : null;
            };

            const nombre =
              contenedor.querySelector("h2")?.innerText.trim() || null;

            return {
              nombre,
              compania: obtenerValor("Compañía"),
              plan: obtenerValor("Plan"),
              contrato: obtenerValor("Contrato"),
              estado: obtenerValor("Estado"),
              tipoDocumento: obtenerValor("Tipo Documento"),
              numeroDocumento: obtenerValor("Número Documento"),
              fechaNacimiento: obtenerValor("Fecha Nacimiento"),
              edad: obtenerValor("Edad"),
              sexo: obtenerValor("Sexo"),
            };
          });

          if (!datosUsuario) {
            throw new Error("No se encontró información del usuario");
          }

          const estadosValidos = ["ACTIVO", "VIGENTE"];
          const esActivo = estadosValidos.includes(
            datosUsuario.estado?.toUpperCase(),
          );

          let puedeAgendar = false;
          let motivo = "";

          if (!esActivo) {
            motivo = "Paciente inactivo";
            resultado = {
              paciente: datosUsuario.nombre,
              estado: datosUsuario.estado,
              puedeAgendar: false,
              motivo: "Paciente inactivo",
            };
          } else if (tipoEntidad === "COLSANITAS") {
            // No requiere autorización
            puedeAgendar = true;

            resultado = {
              paciente: datosUsuario.nombre,
              estado: datosUsuario.estado,
              compania: datosUsuario.compania,
              plan: datosUsuario.plan,
              tipoEntidad,
              puedeAgendar: true,
              motivo: "",
            };

          } else if (tipoEntidad === "EPS") {
            const autorizacionLabel = page.locator("label", {
              hasText: "Servicios con Autorización",
            });
            await autorizacionLabel.waitFor({
              state: "visible",
              timeout: 90000,
            });
            await autorizacionLabel.click();

            await page.waitForTimeout(2000);

            const sinVolantes = await page.locator(
              "#formaVDGeneral\\:servicios\\:includeSeleccionUsuario\\:formaSeleccionUsuario\\:j_id175 .rich-messages-label"
            ).isVisible().catch(() => false);

            if (sinVolantes) {
              resultado = {
                paciente: datosUsuario.nombre,
                estado: datosUsuario.estado,
                tipoEntidad,
                puedeAgendar: false,
                motivo: "No tiene autorizaciones válidas para ENFASO",
              };
            } else {
              await page
                .locator(
                  "#formaVDGeneral\\:servicios\\:includeSeleccionUsuario\\:formaSeleccionUsuario\\:continuarPaso0",
                )
                .click();
  
              await page.waitForSelector(
                "#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:detListPrest",
                { timeout: 30000 },
              );
  
              // Extraer autorizaciones y subfilas
              const autorizaciones = await page.evaluate(() => {
                const tbody = document.querySelector(
                  "#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:detListPrest\\:tb",
                );
                if (!tbody) return [];
  
                const filasPrincipales = Array.from(
                  tbody.querySelectorAll("tr.rich-table-row"),
                );
  
                return filasPrincipales.map((fila) => {
                  const celdas = fila.querySelectorAll("td");
  
                  const numeroAutorizacion = celdas[1]?.innerText.trim();
                  const tipoAutorizacion = celdas[2]?.innerText.trim();
                  const fechaAprobacion = celdas[3]?.innerText.trim();
                  const fechaVigencia = celdas[4]?.innerText.trim();
                  const estado = celdas[5]?.innerText.trim();
                  const prestador = celdas[6]?.innerText.trim();
  
                  const subFila = fila.nextElementSibling?.classList.contains(
                    "rich-subtable-row",
                  )
                    ? fila.nextElementSibling
                    : null;
  
                  // Tomar solo los td visibles en la subfila
                  const celdasSub = Array.from(
                    subFila?.querySelectorAll("td") || [],
                  );
  
                  const codigo = celdasSub[1]?.innerText.trim();
                  const descripcion = celdasSub[2]?.innerText.trim();
                  const cantidad = celdasSub[7]?.innerText.trim();
  
                  return {
                    numeroAutorizacion,
                    tipoAutorizacion,
                    fechaAprobacion,
                    fechaVigencia,
                    estado,
                    prestador,
                    codigo,
                    descripcion,
                    cantidad,
                  };
                });
              });
  
              // Filtrar autorizaciones válidas
              const hoy = moment().tz("America/Bogota").startOf("day");
  
              const autorizacionesValidas = autorizaciones.filter((a) => {
                if (!a.fechaVigencia) return false;
  
                const fechaVigencia = moment
                  .tz(a.fechaVigencia, "DD/MM/YYYY", "America/Bogota")
                  .endOf("day");
                const vigente = fechaVigencia.isSameOrAfter(hoy);
  
                const estadoValido = a.estado?.toUpperCase() === "APROBADA";
  
                const prestadorValido = a.prestador
                  ?.toUpperCase()
                  .includes("ENFASO");
  
                const codigosPermitidos = ["1005434", "1005435", "1005436"];
                const codigoValido = codigosPermitidos.some((c) =>
                  a.codigo?.includes(c),
                );
  
                return estadoValido && prestadorValido && vigente && codigoValido;
              });
  
              // Si hay autorizaciones válidas, abrir "Mostrar" y extraer modalidad
              if (autorizacionesValidas.length > 0) {
                await page.locator("a", { hasText: "Mostrar" }).first().click();
  
                // Esperar que el spinner desaparezca
                await page.waitForSelector("#buscandoDetalle", {
                  state: "hidden",
                  timeout: 30000,
                });
  
                // Esperar un momento para que el modal se renderice
                await page.waitForTimeout(2000);
  
                // Evaluar dentro del browser directamente sin waitForSelector previo
                const infoModal = await page.evaluate(() => {
                  // Buscar el contenedor del modal que está visible
                  const contenedor = document.querySelector(
                    "#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:detalle-volanteContentDiv",
                  );
  
                  if (!contenedor) {
                    console.log("No se encontró el contenedor del modal");
                    return null;
                  }
  
                  // Verificar que el contenedor esté visible
                  const style = window.getComputedStyle(
                    contenedor.parentElement.parentElement,
                  );
                  if (style.display === "none") {
                    console.log("El contenedor del modal no está visible");
                    return null;
                  }
  
                  // Buscar la tabla dentro del contenedor visible
                  const tabla = contenedor.querySelector("#tablaDetalleVolante");
  
                  if (!tabla) {
                    console.log(
                      "No se encontró tabla #tablaDetalleVolante en el contenedor",
                    );
                    return null;
                  }
  
                  const datos = {};
  
                  // Buscar todas las filas de la tabla principal
                  const filas = tabla.querySelectorAll("tbody > tr");
  
                  console.log(`Se encontraron ${filas.length} filas en la tabla`);
  
                  // Modalidad (Lugar) y Prestador
                  for (let fila of filas) {
                    const celdas = fila.querySelectorAll("td");
  
                    // Solo procesar filas que tengan exactamente 2 celdas sin colspan
                    if (
                      celdas.length === 2 &&
                      !celdas[0].hasAttribute("colspan")
                    ) {
                      const label = celdas[0].textContent.trim();
                      const valor = celdas[1].textContent.trim();
  
                      console.log(
                        `Fila encontrada - Label: "${label}", Valor: "${valor}"`,
                      );
  
                      if (label === "Lugar") {
                        datos.modalidad = valor;
                      } else if (label === "Prestador que ordena:") {
                        datos.prestador = valor;
                      }
                    }
                  }
  
                  // Observaciones codificadas
                  const obsCodif = [];
                  const tablaObsCodif = contenedor.querySelector(
                    "#tablaDetalleVolObsCodif tbody",
                  );
  
                  if (tablaObsCodif) {
                    const filasObs = tablaObsCodif.querySelectorAll("tr");
                    console.log(
                      `Se encontraron ${filasObs.length} observaciones codificadas`,
                    );
  
                    filasObs.forEach((tr) => {
                      const celdas = tr.querySelectorAll("td");
                      if (celdas.length === 2) {
                        obsCodif.push({
                          codigo: celdas[0].textContent.trim(),
                          observacion: celdas[1].textContent.trim(),
                        });
                      }
                    });
                  } else {
                    console.log(
                      "No se encontró tabla de observaciones codificadas",
                    );
                  }
  
                  datos.observacionesCodificadas = obsCodif;
  
                  return datos;
                });
  
  
                if (infoModal) {
                  autorizacionesValidas[0].modalidad = infoModal.modalidad;
                  autorizacionesValidas[0].prestadorQueOrdena = infoModal.prestador;
                  autorizacionesValidas[0].observacionesCodificadas = infoModal.observacionesCodificadas;
                }
              }
  
              // Determinar si se puede agendar
              puedeAgendar = false;
              motivo = "";
  
              if (autorizacionesValidas.length === 0) {
                motivo = "No tiene autorizaciones válidas para ENFASO";
              } else {
                puedeAgendar = true;
              }
  
              // Mostrar resultados
              resultado = {
                paciente: datosUsuario.nombre,
                estado: datosUsuario.estado,
                compania: datosUsuario.compania,
                plan: datosUsuario.plan,
                tipoDocumento: datosUsuario.tipoDocumento,
                numeroDocumento: datosUsuario.numeroDocumento,
                tipoEntidad,
                autorizaciones,
                autorizacionesValidas,
                puedeAgendar,
                motivo,
              };

            }
          } else {
            motivo = "Tipo de entidad no reconocido";
            resultado = {
              paciente: datosUsuario.nombre,
              estado: datosUsuario.estado,
              tipoEntidad,
              puedeAgendar: false,
              motivo: "Tipo de entidad no reconocido",
            };
          }
        } else if (tipoConsulta === "numAutorizacion") {
          console.log("Consulta por NUMERO DE AUTORIZACION");

          const radioAut = page.locator("label", {
            hasText: "Número de Autorización",
          });
          await radioAut.waitFor({ state: "visible", timeout: 90000 });
          await radioAut.click();

          await page.waitForTimeout(2000);

          await page.fill("#formaVDGeneral\\:nroSolicitud", numAutorizacion);

          await page.locator("#formaVDGeneral\\:btnConsultarUsuario").click();
          await page.waitForTimeout(3000);

          // ── 1. Datos del usuario ──────────────────────────────────────────────────
          await page.waitForSelector("#info-usuario", { timeout: 30000 });

          const datosUsuario = await page.evaluate(() => {
            const contenedor = document.querySelector("#info-usuario");
            if (!contenedor) return null;

            const obtenerValor = (labelTexto) => {
              const labels = Array.from(contenedor.querySelectorAll("label"));
              const label = labels.find((l) => l.innerText.trim().includes(labelTexto));
              if (!label) return null;
              const datoDiv = label.parentElement.querySelector(".info-dato");
              return datoDiv ? datoDiv.innerText.trim() : null;
            };

            return {
              nombre: contenedor.querySelector("h2")?.innerText.trim() || null,
              compania: obtenerValor("Compañía"),
              plan: obtenerValor("Plan"),
              contrato: obtenerValor("Contrato"),
              estado: obtenerValor("Estado"),
              tipoDocumento: obtenerValor("Tipo Documento"),
              numeroDocumento: obtenerValor("Número Documento"),
              fechaNacimiento: obtenerValor("Fecha Nacimiento"),
              edad: obtenerValor("Edad"),
              sexo: obtenerValor("Sexo"),
            };
          });

          if (!datosUsuario) throw new Error("No se encontró información del usuario");

          const estadosValidos = ["ACTIVO", "VIGENTE"];
          const esActivo = estadosValidos.includes(datosUsuario.estado?.toUpperCase());

          let puedeAgendar = false;
          let motivo = "";

          if (!esActivo) {
            motivo = "Paciente inactivo";
            resultado = {           // ← asignar resultado, no solo console.log
              paciente: datosUsuario.nombre,
              estado: datosUsuario.estado,
              puedeAgendar: false,
              motivo: "Paciente inactivo",
            };
          } else {
            // ── 2. Esperar tabla de autorizaciones (ya visible sin navegar al label) ──
            await page.waitForSelector(
              "#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:detListPrest",
              { timeout: 30000 }
            );

            // ── 3. Extraer autorizaciones (misma lógica que en flujo documento) ───────
            const autorizaciones = await page.evaluate(() => {
              const tbody = document.querySelector(
                "#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:detListPrest\\:tb"
              );
              if (!tbody) return [];

              return Array.from(tbody.querySelectorAll("tr.rich-table-row")).map((fila) => {
                const celdas = fila.querySelectorAll("td");
                const subFila = fila.nextElementSibling?.classList.contains("rich-subtable-row")
                  ? fila.nextElementSibling : null;
                const celdasSub = Array.from(subFila?.querySelectorAll("td") || []);

                return {
                  numeroAutorizacion: celdas[1]?.innerText.trim(),
                  tipoAutorizacion:   celdas[2]?.innerText.trim(),
                  fechaAprobacion:    celdas[3]?.innerText.trim(),
                  fechaVigencia:      celdas[4]?.innerText.trim(),
                  estado:             celdas[5]?.innerText.trim(),
                  prestador:          celdas[6]?.innerText.trim(),
                  codigo:             celdasSub[1]?.innerText.trim(),
                  descripcion:        celdasSub[2]?.innerText.trim(),
                  cantidad:           celdasSub[7]?.innerText.trim(),
                };
              });
            });

            // ── 4. Filtrar autorizaciones válidas ─────────────────────────────────────
            const hoy = moment().tz("America/Bogota").startOf("day");

            const autorizacionesValidas = autorizaciones.filter((a) => {
              if (!a.fechaVigencia) return false;
              const fechaVigencia = moment.tz(a.fechaVigencia, "DD/MM/YYYY", "America/Bogota").endOf("day");
              const codigosPermitidos = ["1005434", "1005435", "1005436"];

              return (
                a.estado?.toUpperCase() === "APROBADA" &&
                a.prestador?.toUpperCase().includes("ENFASO") &&
                fechaVigencia.isSameOrAfter(hoy) &&
                codigosPermitidos.some((c) => a.codigo?.includes(c))
              );
            });

            // ── 5. Abrir modal "Mostrar" y extraer modalidad ──────────────────────────
            if (autorizacionesValidas.length > 0) {
              await page.locator("a", { hasText: "Mostrar" }).first().click();
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
                tabla.querySelectorAll("tbody > tr").forEach((fila) => {
                  const celdas = fila.querySelectorAll("td");
                  if (celdas.length === 2 && !celdas[0].hasAttribute("colspan")) {
                    const label = celdas[0].textContent.trim();
                    const valor = celdas[1].textContent.trim();
                    if (label === "Lugar") datos.modalidad = valor;
                    else if (label === "Prestador que ordena:") datos.prestador = valor;
                  }
                });

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
                autorizacionesValidas[0].modalidad = infoModal.modalidad;
                autorizacionesValidas[0].prestadorQueOrdena = infoModal.prestador;
                autorizacionesValidas[0].observacionesCodificadas = infoModal.observacionesCodificadas;
              }
            }

            if (autorizacionesValidas.length === 0) {
              motivo = "No tiene autorizaciones válidas para ENFASO";
            } else {
              puedeAgendar = true;
            }

            resultado = {
              paciente: datosUsuario.nombre,
              estado: datosUsuario.estado,
              compania: datosUsuario.compania,
              plan: datosUsuario.plan,
              edad: datosUsuario.edad,
              sexo: datosUsuario.sexo,
              autorizaciones,
              autorizacionesValidas,
              puedeAgendar,
              motivo,
            };
          }
        } else {
          throw new Error("tipoConsulta no válido");
        }

        console.log("Proceso completado");

        return res.status(200).json({
          mensaje: "Proceso completado",
          ...resultado,
        });
   
  } catch (error) {
    console.error("Error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        mensaje: "Error al iniciar el proceso",
        error: error.message,
      });
    }
  } finally {
    // ✅ Siempre se ejecuta, haya error o no
    try {
      await browser.close();
      await client.sessions.stop(session.id);
      console.log("🔒 Sesión cerrada correctamente");
    } catch (e) {
      console.error("Error al cerrar sesión:", e.message);
    }
  }
}

async function detectarSesionExpirada(page) {
  try {
    // OPCIÓN 1: Buscar el formulario de login
    const formularioLoginVisible = await page.locator('#_Authentication_docNumber').isVisible({ timeout: 3000 });
    
    if (formularioLoginVisible) {
      return true; // Hay formulario = sesión expirada
    }

    // OPCIÓN 2: Verificar URL (si redirige al login)
    const urlActual = page.url();
    if (urlActual.includes('/login') || urlActual.includes('/signin')) {
      return true;
    }

    // OPCIÓN 3: Buscar elemento que solo existe cuando está logueado
    const elementoAutenticado = await page.locator('a:has-text("Salud")').count();
    if (elementoAutenticado === 0) {
      return true; // No encuentra menú = no está logueado
    }

    return false; // Todo bien, sesión activa

  } catch (error) {
    console.log("Error detectando sesión, asumiendo expirada:", error.message);
    return true; // Por defecto, asumir que expiró
  }
}


// PRIMERA VEZ: Login y creación de perfil
export const AutorizacionColpatriaInicial = async (req, res) => {
  const { usuario, clave, documento } = req.body;

  try {
    // 1️⃣ Crear un perfil nuevo
    const profile = await client.profiles.create({
      name: `colpatria-${usuario}`, // Nombre único por usuario
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
          "https://proveedores.axacolpatria.co/web/proveedor/login",
        );

        // 1️⃣ Poner usuario
        await page.fill("#_Authentication_docNumber", usuario);

        // 2️⃣ Poner contraseña
        await page.fill("#_Authentication_password", clave);

        // 3️⃣ Click en Iniciar Sesión
        await page.locator('button:has-text("Iniciar Sesión")').click();

        // 4️⃣ Click en Salud
        await page.locator('a:has-text("Salud")').first().click();
        await page.waitForLoadState('networkidle');

        // 5️⃣ Click en Consulta de autorizaciones
        await page.locator('div#layout_46991 >> role=menuitem').click();
        await page.waitForLoadState('networkidle');

        // 6️⃣ Poner documento
        await page.waitForSelector(
          '#_Consultadeautorizacionesdesalud_INSTANCE_e5P7yim3vwg5_queryFilter'
        );

        await page.fill(
          '#_Consultadeautorizacionesdesalud_INSTANCE_e5P7yim3vwg5_queryFilter',
          documento
        );

        await page.locator('button:has-text("Consultar")').click();

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
};


// VERSIÓN AVANZADA: Auto-renovación de perfil
export const AutorizacionColpatria = async (req, res) => {
  const { documento, profileId, usuario, clave } = req.body;

  try {
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
      mensaje: "Proceso iniciado",
      liveUrl: session.liveUrl,
    });

    (async () => {
      try {
        let browser = await chromium.connectOverCDP(session.wsEndpoint);
        let context = browser.contexts()[0];
        let page = context.pages()[0];

        await page.goto(
          "https://proveedores.axacolpatria.co/web/proveedor/login",
          { waitUntil: 'networkidle' }
        );

        const sesionExpirada = await detectarSesionExpirada(page);

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
            "https://proveedores.axacolpatria.co/web/proveedor/login"
          );

          // Re-login
          await page.fill("#_Authentication_docNumber", usuario);
          await page.fill("#_Authentication_password", clave);
          await page.locator('button:has-text("Iniciar Sesión")').click();
          await page.waitForLoadState('networkidle');

          console.log("✅ Perfil renovado con nueva sesión");
        }

        // Continuar con el flujo normal
        await page.locator('a:has-text("Salud")').first().click();
        await page.waitForLoadState('networkidle');

        await page.locator('div#layout_46991 >> role=menuitem').click();
        await page.waitForLoadState('networkidle');

        await page.waitForSelector(
          '#_Consultadeautorizacionesdesalud_INSTANCE_e5P7yim3vwg5_queryFilter'
        );

        await page.fill(
          '#_Consultadeautorizacionesdesalud_INSTANCE_e5P7yim3vwg5_queryFilter',
          documento
        );
        await page.waitForTimeout(2000);
        await page.locator('button:has-text("Consultar")').click();
        await page.waitForTimeout(5000);

        // 1️⃣ Esperar que la tabla cargue
        await page.waitForSelector('#queriesTable tbody tr', { timeout: 5000 });

        // 2️⃣ Tomar la fila más reciente (primera)
        const firstRow = page.locator('#queriesTable tbody tr').first();
        const keyNumber = await firstRow.locator('td').nth(4).innerText(); // columna "No. de solicitud"
        console.log("🔹 KeyNumber encontrado:", keyNumber);

        const cookies = await context.cookies('https://proveedores.axacolpatria.co');
        const cookieHeader = cookies
          .filter(c => /^[a-zA-Z0-9_\-\.]+$/.test(c.name))
          .map(c => `${c.name}=${c.value.replace(/[\r\n\x00-\x1F\x7F]/g, '')}`)
          .join('; ');

        cookies.forEach(c => {
          if (/[\r\n\x00-\x1F\x7F]/.test(c.value) || /[\r\n\x00-\x1F\x7F]/.test(c.name)) {
            console.log('⚠️ Cookie problemática:', c.name, '| valor:', JSON.stringify(c.value));
          }
        });

        const formData = new URLSearchParams();
        formData.append("_Consultadeautorizacionesdesalud_INSTANCE_e5P7yim3vwg5_keyNumber", keyNumber);
        formData.append("_Consultadeautorizacionesdesalud_INSTANCE_e5P7yim3vwg5_cmd", "download-list");
        const postUrl = "https://proveedores.axacolpatria.co/group/salud/consulta-de-autorizaciones-medicas?p_p_id=Consultadeautorizacionesdesalud_INSTANCE_e5P7yim3vwg5&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage";

        console.log('📤 Body:', formData.toString());
        console.log('📤 Cookie header:', cookieHeader);

        const resp = await fetch(postUrl, {
          method: "POST",
          body: formData.toString(),
          headers: {
            "Cookie": cookieHeader,
            "Content-Type": "application/x-www-form-urlencoded",
          }
        });

        // 👇 Ver qué responde antes de parsear JSON
        const text = await resp.text();
        console.log('📥 Status:', resp.status);
        console.log('📥 Response text:', text);
        let downloadUrl;

        // Solo parsear si es JSON
        try {
          const json = JSON.parse(text);
          console.log('📥 Response JSON:', json);
          downloadUrl = json.url;
        } catch (e) {
          console.log('❌ No es JSON, la respuesta es:', text.substring(0, 500));
        }

        console.log("🔹 URL de descarga:", downloadUrl);

        const downloadResp = await fetch(downloadUrl, {
          method: "GET",
          headers: {
            "Cookie": cookieHeader
          }
        });

        console.log('📥 Download status:', downloadResp.status);

        const arrayBuffer = await downloadResp.arrayBuffer();

        const pdfDoc = await pdfjsLib.getDocument({
          data: new Uint8Array(arrayBuffer),
          password: documento,
          useSystemFonts: true,
          disableFontFace: true,
        }).promise;

        let fullText = '';
        for (let i = 1; i <= pdfDoc.numPages; i++) {
          const page = await pdfDoc.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map(item => item.str).join(' ');
          fullText += pageText + '\n';
        }

        const extraerDatos = (text) => {
          const get = (regex) => {
            const match = text.match(regex);
            return match?.[1]?.trim() || null;
          };

          return {
            fechaExpedicion: get(/(\d{1,2}\/\d{1,2}\/\d{4})\s+Fecha\s+De\s+Expedición/i),
            autorizacionNo: get(/(\d{6,})\s+Autorización\s+No/i),
            CC: get(/CC\s+(\d+)/i),
            nombre: get(/CC\s+\d+\s+([A-ZÁÉÍÓÚÑ\s]+?)\s+Plan:/i),
            codigoPlan: get(/Contrato\s+\d+\s+(\d+)\s+Código\s+Plan:/i),
            plan: get(/Código\s+Plan:\s+(.+?)\s+CC/i),
            codigoServicio: get(/Código\s+Servicio\s+(\d+)/i),
            servicio: get(/Servicio\s+\d+\s+([A-ZÁÉÍÓÚÑ\s]+?)\s+Código\s+Diágnostico/i),
            codigoDiagnostico: get(/Código\s+Diágnostico\s+([A-Z0-9]+)/i),
            diagnostico: get(/Diágnostico\s+[A-Z0-9]+\s+([A-ZÁÉÍÓÚÑ\s,]+?)\s+Medicamento/i),
            observaciones: get(/Observaciones\s+([\s\S]+?)\s+Autorizado\s+Por:/i),
          };
        };

        const datos = extraerDatos(fullText);
        console.log('📋 Datos extraídos:', datos);

        console.log("✅ Proceso completado");

        // Cerrar sesión para guardar cambios (si hubo re-login)
        // if (sesionExpirada) {
        //   await client.sessions.stop(session.id);
        // }

      } catch (error) {
        console.error("Error en proceso:", error);
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
};

