function normalizarFecha(fecha) {
  if (!fecha) return "";

  const s = String(fecha).trim();

  // si viene tipo 2026-03-03
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}T05:00:00.000Z`;
  }

  // ✅ Agrega este: si viene tipo 2026/04/25
  const isoSlash = s.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (isoSlash) {
    return `${isoSlash[1]}-${isoSlash[2]}-${isoSlash[3]}T05:00:00.000Z`;
  }

  // si ya viene tipo 24/02/2026
  const lat = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (lat) {
    const d = lat[1].padStart(2, "0");
    const m = lat[2].padStart(2, "0");
    return `${lat[3]}-${m}-${d}T05:00:00.000Z`;
  }

  return s;
}


export const transformarAutorizaciones = (data) => {
  
  return data
    .filter((row) => {
      const estado = row["ESTADO AUTORIZACIÓN"]?.toString().trim().toUpperCase();
      return estado !== "AUTORIZACION ANULADA";
    })
    .map((row, i) => {
      const fechaRaw = row["FECHA EMISIÓN"];
      const fechaNormalizada = normalizarFecha(fechaRaw);

      const cedula = row["TIPO ID AFILIADO"]?.toString().split(" ")[1] || "";
      const servicio = `${row["CÓDIGO SERVICIO"] || ""} - ${row["DESCRIPCIÓN"] || ""}`;

      return {
        "Cédula *": cedula,
        "Nombres *": row["NOMBRE AFILIADO"] || "",
        "Fecha de Expedición *": fechaNormalizada,
        "Servicio *": servicio,
        "Número de Autorización": row["NÚMERO AUTORIZACIÓN"] || "",
        "Número de Radicación *": row["NÚMERO RADICACIÓN"] || "",
        "Observaciones": row["OBSERVACIONES"] || "",
        "Agendada": false
      };
    });
};



export const transformarAutorizacionesGuajira = (filaTabla) => {
  if (!filaTabla?.autorizaciones?.length) return [];

  return filaTabla.autorizaciones.map((aut) => ({
    "Cédula *": filaTabla.cedula || "",
    "Nombres *": filaTabla.nombres || "",
    "Fecha de Expedición *": aut.fechaAutorizacion || "",
    "Servicio *": aut.servicio || "",
    "Número de Autorización": aut.numeroAutorizacion || "",
    "Número de Radicación *": aut.numeroRadicacion || "",
    "Observaciones": "", // Ya no estás trayendo detalles
    "Agendada": false
  }));
};


const CODIGOS_ESPERANZA = new Set([
  "61002", "61302", "401101", "542402", "586102", "601101",
  "641201", "832102", "851101", "851102", "860101", "860102",
  "870001", "870003", "870004", "870005", "870006", "870007",
  "870101", "870102", "870103", "870104", "870105", "870107",
  "870108", "870112", "870113", "870131", "870601", "870602",
  "870603", "871010", "871019", "871020", "871030", "871040",
  "871050", "871060", "871061", "871062", "871070", "871091",
  "871111", "871112", "871121", "871129", "871208", "871320",
  "872002", "872011", "872101", "872102", "872103", "872104",
  "872105", "872121", "872122", "872123", "873001", "873002",
  "873003", "873004", "873111", "873112", "873121", "873122",
  "873204", "873205", "873206", "873210", "873302", "873305",
  "873306", "873311", "873312", "873313", "873314", "873333",
  "873335", "873340", "873411", "873420", "873423", "873431",
  "873443", "873444", "876801", "876802", "879111", "879112",
  "879113", "879116", "879121", "879122", "879131", "879132",
  "879150", "879161", "879162", "879201", "879205", "879301",
  "879410", "879420", "879421", "879430", "879460", "879510",
  "879520", "879522", "879523", "879910", "879990", "881112",
  "881130", "881131", "881132", "881141", "881151", "881201",
  "881211", "881212", "881301", "881302", "881305", "881306",
  "881313", "881332", "881360", "881362", "881401", "881402",
  "881403", "881431", "881432", "881434", "881435", "881436",
  "881437", "881501", "881510", "881511", "881601", "881602",
  "881610", "881611", "881612", "881613", "881620", "881621",
  "881622", "881630", "881640", "881701", "882112", "882132",
  "882203", "882212", "882222", "882232", "882242", "882252",
  "882298", "882307", "882308", "882309", "882316", "882317",
  "882318", "882602", "882603", "891401", "891410", "891901",
  "894102", "895001", "895100", "895101", "951302", "1005927",
  "751101", "881438", "881439", "897011"
]);

export const transformarAutorizacionesEsperanza = (data) => {
  return data
    .filter((row) => {
      const prestador = row["NOMBRE_PRESTADOR_PRACTICA"]?.toString().trim().toUpperCase();
      return prestador === "CLINICA ESPERANZA SAS";
    })
    .filter((row) => {
      const codigo = row["CODIGO_PROCEDIMIENTO"]?.toString().trim();
      return CODIGOS_ESPERANZA.has(codigo);
    })
    .map((row) => {
      const cedula = row["NUM_IDENT_AFILIADO"]?.toString() || "";
      const servicio = `${row["CODIGO_PROCEDIMIENTO"] || ""} - ${row["DESCRIPCION_SERVICIO"] || ""}`;

      return {
        "Cédula *": cedula,
        "Nombres *": row["NOMBRE_PACIENTE"] || "",
        "Fecha de Expedición *": normalizarFecha(row["FECHA_ORDEN_MEDICA"]),
        "Servicio *": servicio,
        "Número de Autorización": row["NUM_AUTORIZACION"] || "",
        "Número de Radicación *": row["NUM_AUTORIZACION"] || "",
        "Observaciones": row["CANTIDAD"] ? `Cantidad: ${row["CANTIDAD"]}` : "",
        "Agendada": false
      };
    });
};