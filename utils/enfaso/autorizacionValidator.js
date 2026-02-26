import moment from "moment-timezone";


// Función reutilizable para extraer autorizaciones
export const extraerAutorizaciones = async (page) => {
  return await page.evaluate(() => {
    const tbody = document.querySelector(
      "#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:detListPrest\\:tb"
    );
    if (!tbody) return [];

    const filasPrincipales = Array.from(tbody.querySelectorAll("tr.rich-table-row"));
    
    return filasPrincipales.map(fila => {
      const celdas = fila.querySelectorAll("td");

      const numeroAutorizacion = celdas[1]?.innerText.trim();
      const tipoAutorizacion = celdas[2]?.innerText.trim();
      const fechaAprobacion = celdas[3]?.innerText.trim();
      const fechaVigencia = celdas[4]?.innerText.trim();
      const estado = celdas[5]?.innerText.trim();
      const prestador = celdas[6]?.innerText.trim();

      const subFila = fila.nextElementSibling?.classList.contains("rich-subtable-row")
        ? fila.nextElementSibling
        : null;

      const celdasSub = Array.from(subFila?.querySelectorAll("td") || []);
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
        cantidad
      };
    });
  });
};

// Función para filtrar autorizaciones válidas
export const filtrarAutorizacionesValidas = (autorizaciones) => {
  const hoy = moment().tz("America/Bogota").startOf("day");
  const codigosPermitidos = ["1005434", "1005435", "1005436"];

  return autorizaciones.filter(a => {
    if (!a.fechaVigencia) return false;

    const fechaVigencia = moment.tz(a.fechaVigencia, "DD/MM/YYYY", "America/Bogota").endOf("day");
    const vigente = fechaVigencia.isSameOrAfter(hoy);
    const estadoValido = a.estado?.toUpperCase() === "APROBADA";
    const prestadorValido = a.prestador?.toUpperCase().includes("ENFASO");
    const codigoValido = codigosPermitidos.some(c => a.codigo?.includes(c));

    return estadoValido && prestadorValido && vigente && codigoValido;
  });
};

// Función para extraer información del modal
export const extraerInfoModal = async (page) => {
  await page.locator("a", { hasText: "Mostrar" }).first().click();
  await page.waitForSelector('#buscandoDetalle', { state: 'hidden', timeout: 30000 });
  await page.waitForTimeout(2000);

  return await page.evaluate(() => {
    const contenedor = document.querySelector(
      '#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:detalle-volanteContentDiv'
    );
    
    if (!contenedor) return null;

    const style = window.getComputedStyle(contenedor.parentElement.parentElement);
    if (style.display === 'none') return null;

    const tabla = contenedor.querySelector('#tablaDetalleVolante');
    if (!tabla) return null;

    const datos = {};
    const filas = tabla.querySelectorAll('tbody > tr');

    for (let fila of filas) {
      const celdas = fila.querySelectorAll('td');
      
      if (celdas.length === 2 && !celdas[0].hasAttribute('colspan')) {
        const label = celdas[0].textContent.trim();
        const valor = celdas[1].textContent.trim();
        
        if (label === 'Lugar') {
          datos.modalidad = valor;
        } else if (label === 'Prestador que ordena:') {
          datos.prestador = valor;
        }
      }
    }

    const obsCodif = [];
    const tablaObsCodif = contenedor.querySelector('#tablaDetalleVolObsCodif tbody');
    
    if (tablaObsCodif) {
      const filasObs = tablaObsCodif.querySelectorAll('tr');
      filasObs.forEach(tr => {
        const celdas = tr.querySelectorAll('td');
        if (celdas.length === 2) {
          obsCodif.push({ 
            codigo: celdas[0].textContent.trim(), 
            observacion: celdas[1].textContent.trim() 
          });
        }
      });
    }
    
    datos.observacionesCodificadas = obsCodif;
    return datos;
  });
};

// Función principal para procesar autorizaciones EPS
export const procesarAutorizacionesEPS = async (page) => {
  const autorizacionLabel = page.locator("label", { hasText: "Servicios con Autorización" });
  await autorizacionLabel.waitFor({ state: "visible", timeout: 90000 });
  await autorizacionLabel.click();

  await page.locator(
    "#formaVDGeneral\\:servicios\\:includeSeleccionUsuario\\:formaSeleccionUsuario\\:continuarPaso0"
  ).click();

  await page.waitForSelector(
    "#formaVDGeneral\\:servicios\\:includeInformacionServicio\\:frm\\:includeRegistroAdmisionVolantes\\:frm\\:formaConsultaVolantes\\:detListPrest",
    { timeout: 30000 }
  );

  const autorizaciones = await extraerAutorizaciones(page);
  const autorizacionesValidas = filtrarAutorizacionesValidas(autorizaciones);

  if (autorizacionesValidas.length > 0) {
    const infoModal = await extraerInfoModal(page);
    
    if (infoModal) {
      autorizacionesValidas[0].modalidad = infoModal.modalidad;
      autorizacionesValidas[0].prestador = infoModal.prestador;
      autorizacionesValidas[0].observacionesCodificadas = infoModal.observacionesCodificadas;
    }
  }

  return { autorizaciones, autorizacionesValidas };
};