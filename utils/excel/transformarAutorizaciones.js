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
  "697101", "751101", "881401", "881402", "881431", "881432",
  "881434", "881435", "881436", "881437", "881438", "881439",
  "882298", "1005774", "890250", "890250ALR", "890250PNA",
  "890350", "890350ALR", "890350PNA", "897011"
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