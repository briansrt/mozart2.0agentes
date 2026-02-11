import express from "express";
import {
  enviarPresentacion,
  enviarVerificacion,
  enviarAgendamiento,
  enviarRecordatorioCita,
} from "../controllers/whatsapp.controller.js";

const router = express.Router();

router.post("/presentacion", enviarPresentacion);
router.post("/verificacion", enviarVerificacion);
router.post("/agendamiento", enviarAgendamiento);
router.post("/recordatoriocita", enviarRecordatorioCita);

export default router;



