import express from "express";
import { descargarAutorizacion } from "../controllers/automatizacion.controller.js";

const router = express.Router();

router.post("/autorizacionesFamisanar", descargarAutorizacion);

export default router;