import dotenv from "dotenv";
import { Hyperbrowser } from "@hyperbrowser/sdk";
import { chromium } from "playwright-core";
import moment from "moment-timezone";
import { leerExcelDesdeBuffer } from "../utils/excel/leerExcel.js";
import { transformarAutorizaciones } from "../utils/excel/transformarAutorizaciones.js";
import { generarExcelBuffer } from "../utils/excel/escribirExcel.js";
import fetch from "node-fetch";

dotenv.config();

let browser, page, session;
let contextGlobal;
let pageMozartia;

const client = new Hyperbrowser({
  apiKey: process.env.HYPERBROWSER_API_KEY,
});

async function seleccionarPorTexto(selector, texto, page) {
  const value = await page.$eval(
    selector,
    (select, texto) => {
      const option = [...select.options].find((o) =>
        o.textContent.toLowerCase().includes(texto.toLowerCase()),
      );
      return option ? option.value : null;
    },
    texto,
  );

  if (!value) {
    throw new Error(`No se encontró opción con texto: ${texto}`);
  }

  await page.selectOption(selector, value);
}

async function seleccionarSedeHumana(selector, sede, page) {
  const mapa = {
    principal: "manejo de la diabetes s.a.s - cemdi sas",
    suba: "sede suba",
    sur: "sede sur",
  };

  if (!mapa[sede]) {
    throw new Error(`Sede inválida: ${sede}`);
  }

  await seleccionarPorTexto(selector, mapa[sede], page);
}

function parseFecha(fecha) {
  const [day, month, year] = fecha.split("/").map(Number);
  return { day, month, year };
}

async function seleccionarFechaVuetify(frame, inputSelector, fecha) {
  const { day, month, year } = fecha;

  await frame.locator(inputSelector).click();

  const picker = frame.locator(".v-picker--date:visible");
  await picker.waitFor();

  // Año
  await picker.locator(".v-date-picker-title__year").click();
  await picker.locator(`.v-date-picker-years >> text=${year}`).click();

  // Mes
  const meses = [
    "ene.",
    "feb.",
    "mar.",
    "abr.",
    "may.",
    "jun.",
    "jul.",
    "ago.",
    "sept.",
    "oct.",
    "nov.",
    "dic.",
  ];
  await picker
    .locator(".v-date-picker-table--month button")
    .filter({ hasText: meses[month - 1] })
    .first()
    .click({ force: true });

  // Día
  await picker
    .locator(".v-date-picker-table--date button.v-btn:not(.v-btn--disabled)")
    .filter({ hasText: String(day) })
    .first()
    .click({ force: true });
}

export const descargarAutorizacion = async (req, res) => {
  const { usuario, clave, sede, fechaInicio, fechaFin, tenant } = req.body;
  let inicio, fin;

  if (fechaInicio && fechaFin) {
    inicio = parseFecha(fechaInicio);
    fin = parseFecha(fechaFin);
    console.log(
      `📅 Usando fechas proporcionadas: ${fechaInicio} - ${fechaFin}`,
    );
  } else {
    // Obtener día anterior en zona horaria de Colombia
    const ayer = moment().tz("America/Bogota").subtract(1, "days");

    inicio = {
      day: ayer.date(),
      month: ayer.month() + 1,
      year: ayer.year(),
    };
    fin = { ...inicio };

    console.log(`📅 Día anterior (Colombia): ${ayer.format("DD/MM/YYYY")}`);
  }

  try {
    session = await client.sessions.create({ acceptCookies: true });

    res.status(200).json({
      mensaje: "Proceso iniciado",
      liveUrl: session.liveUrl,
    });

    console.log("preview: ", session.liveUrl);

    (async () => {
      try {
        browser = await chromium.connectOverCDP(session.wsEndpoint);
        const context = browser.contexts()[0];
        page = context.pages()[0];

        await page.goto("https://enlinea.famisanar.com.co/Portal/home.jspx");

        // LOGIN
        await page.locator("#loginForm\\:id").fill(usuario);
        await page.locator("#loginForm\\:clave").fill(clave);
        await page.locator("#loginForm\\:loginButton").click();
        await page.waitForLoadState("networkidle");

        // Servicios
        await page.locator("#j_id101").click();
        await page.waitForLoadState("networkidle");

        // IPS
        await page.locator("a", { hasText: "IPS" }).click();
        await page.waitForSelector("#j_id116\\:ips");

        // Seleccionar CEMDI
        await seleccionarPorTexto("#j_id116\\:ips", "CEMDI", page);
        await page.waitForTimeout(1500);

        // Seleccionar sede
        await seleccionarSedeHumana("#j_id116\\:sucIps", sede, page);
        await page.locator("#j_id116\\:acceptButton").click();

        // MENÚ AUTORIZACIONES
        await page
          .locator("div.handPointer", { hasText: "Autorizaciones" })
          .click();
        await page.waitForTimeout(800);
        await page.locator("div.handPointer", { hasText: "Reportes" }).click();
        await page.waitForTimeout(800);
        await page.locator("a", { hasText: "Autorizaciones por IPS" }).click();
        await page.waitForLoadState("networkidle");

        // IFRAME
        await page.waitForSelector("#ifWindows");
        const frame = await (await page.$("#ifWindows"))?.contentFrame();
        if (!frame)
          throw new Error(
            "No se pudo obtener el contenido del iframe ifWindows",
          );

        // Inputs de fecha
        await frame.waitForSelector("#fechainicio:not([disabled])", {
          state: "visible",
        });

        // FECHA INICIO
        await seleccionarFechaVuetify(frame, "#fechainicio", inicio);

        // FECHA FIN
        await frame.waitForSelector("#fechafin:not([disabled])");
        await seleccionarFechaVuetify(frame, "#fechafin", fin);

        // BOTÓN CONSULTAR
        await frame.waitForTimeout(1000);
        await frame.locator("button", { hasText: "Consultar" }).click();

        // Esperar a que aparezca el botón de descargar
        const descargarBtn = frame.locator('a:has-text("Descargar")');
        await descargarBtn.waitFor({
          state: "visible",
          timeout: 30 * 60 * 1000,
        }); // hasta 30 minutos

        // 🔽 DESCARGA REAL DESDE EL NAVEGADOR (mantiene sesión activa)

        // Esperar descarga real desde el navegador
        const [download] = await Promise.all([
          context.waitForEvent("download", { timeout: 30 * 60 * 1000 }), // hasta 30 min
          descargarBtn.click(), // click en el botón dentro del iframe
        ]);

        // Obtener stream del archivo descargado
        const stream = await download.createReadStream();

        if (!stream) {
          throw new Error("No se pudo obtener el stream de la descarga");
        }

        // Leer el buffer completo
        const chunks = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }

        const finalBuffer = Buffer.concat(chunks);

        console.log("✅ Excel descargado correctamente desde iframe");

        // Ahora sí puedes procesarlo
        const dataOriginal = leerExcelDesdeBuffer(finalBuffer);
        const dataTransformada = transformarAutorizaciones(dataOriginal);
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
          .fill(process.env.mozartEmail);
        await pageMozartia
          .locator('input[name="password"]')
          .fill(process.env.mozartPassword);
        await pageMozartia
          .getByRole("button", { name: /Acceder al Sistema/i })
          .click();

        // Esperar que cargue directamente
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
          "https://new.app.mozartia.com/cemdiprueba/medical-authorizations",
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

        // Subir archivo desde buffer
        await fileInput.setInputFiles({
          name: "autorizaciones.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: bufferTransformado,
        });

        const cargarBtn = pageMozartia.getByRole("button", {
          name: /Cargar Archivo/i,
        });

        await pageMozartia
          .locator('button:not([disabled]):has-text("Cargar Archivo")')
          .waitFor({ state: "visible", timeout: 15000 });

        await cargarBtn.click();
        console.log("✅ Excel subido a Mozart");
      } catch (error) {
        console.error("Error en proceso asíncrono:", error);
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
    console.error("Error iniciando sesión:", error);
    res.status(500).send("Error iniciando el proceso");
  }
};
