function normalizarFecha(fecha) {
  if (!fecha) return "";

  const s = String(fecha).trim();

  // si viene tipo 2026-03-03
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}T05:00:00.000Z`;
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
