import express from "express";
import { CrearPQRSCoosalud, ConsultarRadicadoPQRS, enviarCorreosDesdeExcel } from "../controllers/automatizaciones/coosalud/automatizacion.js";
import { AutorizacionGuajira, ConsultarAutorizacion, AgendarCitaGuajiraCristal, ReAgendarCitaGuajiraCristal, CancelarCitaGuajiraCristal, VerificarAsistenciaCitaCristal } from "../controllers/automatizaciones/guajira/automatizacion.js";
import { descargarAutorizacion } from "../controllers/automatizaciones/famisanar/automatizacion.js";
import { AutorizacionColpatria, AutorizacionEnfaso } from "../controllers/automatizaciones/enfaso/automatizacion.js";

const router = express.Router();

router.post("/autorizacionesFamisanar", descargarAutorizacion);
router.post("/autorizacionEnfaso", AutorizacionEnfaso);
router.post("/autorizacionColpatria", AutorizacionColpatria)

router.post("/autorizacionGuajira", AutorizacionGuajira)
router.post('/consultar', ConsultarAutorizacion);
router.post("/agendarCitaQrystalos", AgendarCitaGuajiraCristal)
router.post("/reagendarCitaQrystalos", ReAgendarCitaGuajiraCristal)
router.post("/cancelarCitaQrystalos", CancelarCitaGuajiraCristal)
router.post("/verificarCitaCumplida", VerificarAsistenciaCitaCristal)

router.post("/crearPQRSCoosalud", CrearPQRSCoosalud)
router.post("/consultarRadicadoPQRS", ConsultarRadicadoPQRS)
router.post("/enviarCorreo", enviarCorreosDesdeExcel);

export default router;