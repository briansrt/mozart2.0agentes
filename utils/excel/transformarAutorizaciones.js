export const transformarAutorizaciones = (data) => {
  return data.map(row => {
    // Extraer solo el número de cédula, quitando el tipo (CC, TI, etc.)
    const cedula = row["TIPO ID AFILIADO"]?.toString().split(" ")[1] || "";

    // Servicio = "CÓDIGO SERVICIO - DESCRIPCIÓN"
    const servicio = `${row["CÓDIGO SERVICIO"] || ""} - ${row["DESCRIPCIÓN"] || ""}`;

    return {
      "Cédula *": cedula,
      "Nombres *": row["NOMBRE AFILIADO"] || "",
      "Fecha de Expedición *": row["FECHA EMISIÓN"] || "",
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
    "Fecha de Expedición *": aut.fechaExpedicion || "",
    "Servicio *": aut.servicio || "",
    "Número de Autorización": aut.numeroAutorizacion || "",
    "Número de Radicación *": aut.numeroRadicacion || "",
    "Observaciones": "", // Ya no estás trayendo detalles
    "Agendada": false
  }));
};
