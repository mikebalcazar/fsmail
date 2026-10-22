export interface Env {
  DB: D1Database;
  CORREO: R2Bucket;
  ENTORNO: 'produccion' | 'staging' | 'prueba';
  ORIGEN: string;
  CORREO_REMITENTE: string;
  RESEND_BASE: string;
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  /** Sólo pruebas: deja que el código de acceso viaje en la respuesta. */
  CORREO_DE_VERDAD?: string;
}

export interface Cuenta { id: string; username: string; correo: string; nombre: string | null; creada_at: string }
export interface Dominio {
  id: string; cuenta_id: string; dominio: string; resend_id: string | null; estado: 'pendiente' | 'verificado' | 'fallido';
  registros: string; catch_all: number; creada_at: string; verificada_at: string | null;
}
export interface Direccion { id: string; dominio_id: string; local: string; nombre: string | null; activa: number; creada_at: string }
export interface Mensaje {
  id: string; cuenta_id: string; dominio_id: string; direccion_id: string | null; hilo_id: string; resend_id: string | null;
  message_id: string | null; en_respuesta_a: string | null; de: string; de_nombre: string | null; para: string; asunto: string | null;
  resumen: string | null; fecha: string; carpeta: 'entrada' | 'enviados' | 'archivo' | 'basura'; leido: number; adjuntos: number;
  r2_llave: string; tamano: number | null; autenticacion: string | null; creada_at: string;
}
export interface Adjunto { id: string; mensaje_id: string; nombre: string | null; tipo: string | null; tamano: number | null; content_id: string | null; inline: number; r2_llave: string }

export type Variables = { cuenta: Cuenta; sesion: string };
