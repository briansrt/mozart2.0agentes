import dotenv from "dotenv";
import { Hyperbrowser } from "@hyperbrowser/sdk";
import { chromium } from "playwright-core";
import moment from "moment-timezone";
import fetch from "node-fetch";
import fs from "fs";

dotenv.config();

let browser, page, session;
let contextGlobal;
let pageMozartia;

const client = new Hyperbrowser({
  apiKey: process.env.HYPERBROWSER_API_KEY,
});



export const AutorizacionEnfaso = async (req, res) => {
  const { usuario, clave, tipoConsulta, tipoDocumento, documento, numAutorizacion } = req.body;

  try {
    // Crear sesión
    session = await client.sessions.create({ acceptCookies: true });

    res.status(200).json({
      mensaje: "Proceso iniciado",
      liveUrl: session.liveUrl,
    });

    console.log("preview:", session.liveUrl);

    // Proceso asíncrono en segundo plano
    (async () => {
      try {
        browser = await chromium.connectOverCDP(session.wsEndpoint);
        const context = browser.contexts()[0];
        page = context.pages()[0];

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

        // =============================
        // SELECCIÓN SEGÚN tipoConsulta
        // =============================

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
            console.log({
              paciente: datosUsuario.nombre,
              estado: datosUsuario.estado,
              compania: datosUsuario.compania,
              plan: datosUsuario.plan,
              tipoDocumento: datosUsuario.tipoDocumento,
              numeroDocumento: datosUsuario.numeroDocumento,
              tipoEntidad,
              puedeAgendar,
              motivo,
            });
          } else if (tipoEntidad === "COLSANITAS") {
            // No requiere autorización
            puedeAgendar = true;

            console.log({
              paciente: datosUsuario.nombre,
              estado: datosUsuario.estado,
              compania: datosUsuario.compania,
              plan: datosUsuario.plan,
              tipoDocumento: datosUsuario.tipoDocumento,
              numeroDocumento: datosUsuario.numeroDocumento,
              tipoEntidad,
              puedeAgendar,
              motivo,
            });
          } else if (tipoEntidad === "EPS") {
            const autorizacionLabel = page.locator("label", {
              hasText: "Servicios con Autorización",
            });
            await autorizacionLabel.waitFor({
              state: "visible",
              timeout: 90000,
            });
            await autorizacionLabel.click();

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

                console.log("Datos finales extraídos:", datos);
                return datos;
              });

              console.log("Datos extraídos del modal:", infoModal);

              if (infoModal) {
                autorizacionesValidas[0].modalidad = infoModal.modalidad;
                autorizacionesValidas[0].prestador = infoModal.prestador;
                autorizacionesValidas[0].observacionesCodificadas =
                  infoModal.observacionesCodificadas;
              }
            }

            // Determinar si se puede agendar
            let puedeAgendar = false;
            let motivo = "";

            if (autorizacionesValidas.length === 0) {
              motivo = "No tiene autorizaciones válidas para ENFASO";
            } else {
              puedeAgendar = true;
            }

            // Mostrar resultados
            console.log({
              paciente: datosUsuario.nombre,
              estado: datosUsuario.estado,
              tipoEntidad,
              autorizaciones,
              autorizacionesValidas,
              puedeAgendar,
              motivo,
            });
          } else {
            motivo = "Tipo de entidad no reconocido";
            console.log({
              paciente: datosUsuario.nombre,
              estado: datosUsuario.estado,
              tipoEntidad,
              puedeAgendar,
              motivo,
            });
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
        } else {
          throw new Error("tipoConsulta no válido");
        }

        console.log("Proceso completado");
      } catch (error) {
        console.error("Error en proceso asíncrono:", error);
      }
    })();
  } catch (error) {
    console.error("Error al iniciar sesión:", error);

    if (!res.headersSent) {
      res.status(500).json({
        mensaje: "Error al iniciar el proceso",
        error: error.message,
      });
    }
  }
};

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
        await page.waitForSelector('#queriesTable tbody tr', { timeout: 3000 });

        // 2️⃣ Tomar la fila más reciente (primera)
        const firstRow = page.locator('#queriesTable tbody tr').first();

        // 3️⃣ Click en "Ver detalles"
        await firstRow.locator('td.control-column').click();

        // Esperar que DataTables cree la fila child
        await page.waitForSelector('#queriesTable tbody tr.child');
        
        // Ahora buscar el botón SOLO dentro del child
        const childRow = page.locator('#queriesTable tbody tr.child').first();

        const downloadLink = childRow.locator('a.downloadAction');

        // Esperar que esté visible
        await downloadLink.waitFor({ state: 'visible' });
        
        // Click en el link de descarga
        const pagesBefore = context.pages().length;
        await downloadLink.click();

        const pagesAfter = context.pages().length;

        console.log("🧭 Páginas antes:", pagesBefore);
        console.log("🧭 Páginas después:", pagesAfter);

        // Esperar que Hyperbrowser empaquete el ZIP
        console.log("⏳ Esperando que Hyperbrowser prepare los archivos...");

        let downloadsResponse;
        let retries = 0;
        const maxRetries = 30; // 30 segundos máximo

        while (retries < maxRetries) {
          downloadsResponse = await client.sessions.getDownloadsURL(session.id);

          console.log("📦 Estado descarga:", downloadsResponse?.status);

          if (downloadsResponse?.status === 'completed') {
            break;
          }

          if (downloadsResponse?.status === 'failed') {
            throw new Error("Hyperbrowser marcó la descarga como failed");
          }

          await new Promise(resolve => setTimeout(resolve, 1000));
          retries++;
        }

        if (!downloadsResponse?.downloadsUrl) {
          throw new Error("No se pudo obtener la URL del ZIP");
        }

        console.log("🔗 URL ZIP:", downloadsResponse.downloadsUrl);

        // 🔽 Descargar el ZIP
        const zipResponse = await fetch(downloadsResponse.downloadsUrl);
        const zipBuffer = Buffer.from(await zipResponse.arrayBuffer());

        // Extraer PDF
        const AdmZip = (await import('adm-zip')).default;
        const zip = new AdmZip(zipBuffer);
        const zipEntries = zip.getEntries();

        console.log("📂 Archivos en ZIP:", zipEntries.map(e => e.entryName));

        const pdfEntry = zipEntries.find(e => e.entryName.endsWith('.pdf'));
        if (!pdfEntry) throw new Error('No se encontró PDF en el ZIP');

        const pdfBuffer = pdfEntry.getData();

        // Crear carpeta local
        const downloadDir = path.join(process.cwd(), "descargas");
        await fs.promises.mkdir(downloadDir, { recursive: true });

        const filePath = path.join(downloadDir, `autorizacion_${Date.now()}.pdf`);
        await fs.promises.writeFile(filePath, pdfBuffer);

        console.log("📦 Tamaño:", pdfBuffer.length, "bytes");
        console.log("✅ PDF guardado en:", filePath);

        // 🔴 Cerrar ahora sí después de obtener el archivo
        await browser.close();
        await client.sessions.stop(session.id);

        console.log("✅ Proceso completado");

        // Cerrar sesión para guardar cambios (si hubo re-login)
        if (sesionExpirada) {
          await client.sessions.stop(session.id);
        }

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

