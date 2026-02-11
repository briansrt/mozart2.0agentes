import express from "express";
import dotenv from "dotenv";
import llamadasRoutes from "./routes/llamadas.routes.js";
import whatsappRoutes from "./routes/whatsapp.routes.js";
import automatizacionRoutes from "./routes/automatizacion.routes.js";

dotenv.config();

const app = express();
app.use(express.json());

// Endpoints principales
app.use("/api/llamadas", llamadasRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/automatizacion", automatizacionRoutes)

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(` Servidor corriendo en puerto ${PORT}`));

