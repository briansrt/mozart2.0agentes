// utils/memoryCache.js
const cache = new Map();

export const guardarResultadoEnCache = async (documento, resultado) => {
  cache.set(documento, {
    ...resultado,
    expiraEn: Date.now() + 3600000 // 1 hora
  });
  console.log(`✅ Resultado guardado en memoria para documento ${documento}`);
};

export const obtenerResultadoDeCache = async (documento) => {
  const data = cache.get(documento);
  
  if (!data) return null;
  
  // Verificar si expiró
  if (Date.now() > data.expiraEn) {
    cache.delete(documento);
    return null;
  }
  
  return data;
};

export const eliminarDeCache = async (documento) => {
  cache.delete(documento);
};

// Limpiar cache expirado cada 10 minutos
setInterval(() => {
  const ahora = Date.now();
  for (const [key, value] of cache.entries()) {
    if (ahora > value.expiraEn) {
      cache.delete(key);
    }
  }
}, 600000);