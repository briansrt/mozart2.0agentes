import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import sgMail from '@sendgrid/mail';
import { fileURLToPath } from 'url';

dotenv.config();
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Necesario en ES Modules para __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── ENVÍO: Solicitud de cita médica ───────────────────────────────
export const envioSolicitudCita = async (email, dataPaciente) => {
  try {
    const templatePath = path.join(__dirname, '../templates/solicitudCitaMedica.html');
    let template = await fs.promises.readFile(templatePath, 'utf8');

    const {
      nombrePaciente,
      tipoDocumento,
      idNumber,
      edad,
      telefono,
      grupoRiesgo,
      numeroCaso,
      ipsAtencion,
      servicio
    } = dataPaciente;

    // Construimos dinámicamente los datos
    let datosHtml = '';

    if (nombrePaciente) datosHtml += `<p><strong>Nombre:</strong> ${nombrePaciente}</p>`;
    if (tipoDocumento) datosHtml += `<p><strong>Tipo de documento:</strong> ${tipoDocumento}</p>`;
    if (idNumber) datosHtml += `<p><strong>Número de documento:</strong> ${idNumber}</p>`;
    if (edad) datosHtml += `<p><strong>Edad:</strong> ${edad} años</p>`;
    if (telefono) datosHtml += `<p><strong>Contacto:</strong> ${telefono}</p>`;
    if (grupoRiesgo) datosHtml += `<p><strong>Grupo de riesgo:</strong> ${grupoRiesgo}</p>`;
    if (numeroCaso) datosHtml += `<p><strong>Número de caso:</strong> ${numeroCaso}</p>`;

    // Reemplazos normales
    template = template
      .replace(/{{ipsAtencion}}/g, ipsAtencion || '')
      .replace(/{{servicio}}/g, servicio || '')
      .replace(/{{datosPaciente}}/g, datosHtml);

    const subject = `SOLICITUD DE ASIGNACION DE CITA POR  ${servicio || 'ESPECIALISTA'} ${nombrePaciente || ''} ${tipoDocumento || ''} # ${idNumber || ''}`;

    const msg = {
      to: email,
      from: 'info@mozartai.com.co',
      subject,
      html: template,
    };

    await sgMail.send(msg);

  } catch (error) {
    console.error("Error enviando correo:", error);
    throw error;
  }
};