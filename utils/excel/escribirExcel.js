import XLSX from "xlsx";

export const escribirExcel = (data, outputPath) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "Autorizaciones");
  XLSX.writeFile(wb, outputPath);
};

export const generarExcelBuffer = (data) => {
  const wb = XLSX.utils.book_new();
  const headers = Object.keys(data[0] || {});
  const rows = data.map(row => headers.map(h => row[h]));

  const wsData = [headers, ...rows];
  const ws = {};
  const range = { s: { r: 0, c: 0 }, e: { r: wsData.length - 1, c: headers.length - 1 } };

  wsData.forEach((row, r) => {
    row.forEach((val, c) => {
      const cellAddress = XLSX.utils.encode_cell({ r, c });
      ws[cellAddress] = {
        t: typeof val === "boolean" ? "b" : "s",
        v: val === null || val === undefined ? "" : typeof val === "boolean" ? val : String(val)
      };
    });
  });

  ws["!ref"] = XLSX.utils.encode_range(range);
  XLSX.utils.book_append_sheet(wb, ws, "Autorizaciones");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};