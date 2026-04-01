import express from "express";
import { CrearPQRSCoosalud, ConsultarRadicadoPQRS, enviarCorreosDesdeExcel, enviarTemplateWP, confirmarCitaHSMInicial, confirmarCitaHSM, enviarTemplateContactarPrestadorWP } from "../controllers/automatizaciones/coosalud/automatizacion.js";
import { AutorizacionGuajira, ConsultarAutorizacion, AgendarCitaGuajiraCristal, ReAgendarCitaGuajiraCristal, CancelarCitaGuajiraCristal, VerificarAsistenciaCitaCristal } from "../controllers/automatizaciones/guajira/automatizacion.js";
import { descargarAutorizacion, enviarCorreoCitaEndpoint } from "../controllers/automatizaciones/famisanar/automatizacion.js";
import { AutorizacionColpatria, AutorizacionEnfaso } from "../controllers/automatizaciones/enfaso/automatizacion.js";
import { enviarCorreoComercial } from "../controllers/automatizaciones/comercial/automatizacion.js";
import { autorizacionAgenteFamisanar } from "../controllers/automatizaciones/agents/automatizacion.js";

const router = express.Router();

router.post("/autorizacionesFamisanar", descargarAutorizacion);
router.post("/autorizacionEnfaso", AutorizacionEnfaso);
router.post("/autorizacionColpatria", AutorizacionColpatria)
router.post("/enviarCorreoConfirmacion", enviarCorreoCitaEndpoint)

router.post("/autorizacionGuajira", AutorizacionGuajira)
router.post('/consultar', ConsultarAutorizacion);
router.post("/agendarCitaQrystalos", AgendarCitaGuajiraCristal)
router.post("/reagendarCitaQrystalos", ReAgendarCitaGuajiraCristal)
router.post("/cancelarCitaQrystalos", CancelarCitaGuajiraCristal)
router.post("/verificarCitaCumplida", VerificarAsistenciaCitaCristal)

router.post("/crearPQRSCoosalud", CrearPQRSCoosalud)
router.post("/consultarRadicadoPQRS", ConsultarRadicadoPQRS)
router.post("/enviarCorreo", enviarCorreosDesdeExcel);
router.post("/actualizarHSM", confirmarCitaHSM)
router.post("/enviarNotificacionTemplate", enviarTemplateContactarPrestadorWP)
router.post("/enviarTemplate", enviarTemplateWP)

router.post("/enviarCorreoComercial", enviarCorreoComercial);

router.post("/pruebaAgent", autorizacionAgenteFamisanar)
export default router;