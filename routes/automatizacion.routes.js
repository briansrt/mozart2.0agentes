import express from "express";
import { CrearPQRSCoosalud, ConsultarRadicadoPQRS, enviarCorreosDesdeExcel } from "../controllers/automatizaciones/coosalud/automatizacion.js";
import { AutorizacionGuajira, ConsultarAutorizacion, AgendarCitaGuajiraCristal, ReAgendarCitaGuajiraCristal, CancelarCitaGuajiraCristal, VerificarAsistenciaCitaCristal, descargarAutorizacionEsperanza } from "../controllers/automatizaciones/guajira/automatizacion.js";
import { descargarAutorizacion } from "../controllers/automatizaciones/famisanar/automatizacion.js";
import { AutorizacionColpatria, AutorizacionEnfaso } from "../controllers/automatizaciones/enfaso/automatizacion.js";
import multer from "multer";

const router = express.Router();
const storage = multer.memoryStorage();
export const upload = multer({
  storage,
});

router.post("/autorizacionesFamisanar", descargarAutorizacion);
router.post("/autorizacionEnfaso", AutorizacionEnfaso);
router.post("/autorizacionColpatria", AutorizacionColpatria)

router.post("/autorizacionGuajira", AutorizacionGuajira)
router.post('/consultar', ConsultarAutorizacion);
router.post("/agendarCitaQrystalos", AgendarCitaGuajiraCristal)
router.post("/reagendarCitaQrystalos", ReAgendarCitaGuajiraCristal)
router.post("/cancelarCitaQrystalos", CancelarCitaGuajiraCristal)
router.post("/verificarCitaCumplida", VerificarAsistenciaCitaCristal)
router.post(
  "/descargar-autorizacion",
  upload.single("excel"),
  descargarAutorizacionEsperanza
);

router.post("/crearPQRSCoosalud", CrearPQRSCoosalud)
router.post("/consultarRadicadoPQRS", ConsultarRadicadoPQRS)
router.post("/enviarCorreo", enviarCorreosDesdeExcel);

export default router;