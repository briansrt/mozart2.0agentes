import XLSX from "xlsx";

export const escribirExcel = (data, outputPath) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "Autorizaciones");
  XLSX.writeFile(wb, outputPath);
};

export const generarExcelBuffer = (data) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "Autorizaciones");
  
  // 🔹 IMPORTANTE: Retornar como Buffer de Node.js
  const arrayBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.from(arrayBuffer);
};