# Lector de correos · NexoMail 1.9.0

## Uso

Recarga la extensión y las pestañas de correo. Abre un mensaje desde Correo.
El lector muestra el HTML disponible en la API, conservando tablas, colores,
tipografía y estructura. «Ver texto» cambia a la alternativa de texto.

Las imágenes externas están bloqueadas inicialmente. «Mostrar imágenes» permite
cargar imágenes HTTPS para ese mensaje; el remitente o su proveedor de imágenes
puede registrar esa solicitud. Al cambiar de mensaje vuelven a bloquearse.
Los píxeles con dimensiones declaradas de 0 a 2 px se omiten, pero esto no
garantiza eliminar todos los mecanismos de seguimiento.

Los enlaces se enumeran bajo «Enlaces del mensaje». Al elegir uno se muestra
su dirección completa y se solicita confirmación antes de abrir otra pestaña.
No se visitan las direcciones para comprobar su reputación.

## Implementación

- Gmail conserva el HTML MIME que antes se descartaba. El texto destinado al
  asistente permanece separado del HTML de presentación.
- Outlook utiliza el HTML de Microsoft Graph en el mismo tipo de lector.
- El HTML pasa por una lista de elementos y atributos permitidos y se presenta
  en un iframe con sandbox vacío, sin permisos para ejecutar scripts, navegar
  la aplicación, abrir ventanas ni enviar formularios.
- Una política CSP adicional bloquea scripts, conexiones, marcos, objetos,
  fuentes remotas y formularios. Solo se habilitan imágenes HTTPS cuando el
  usuario lo solicita; nunca se cargan imágenes HTTP ni destinos CID sin resolver.
- Se eliminan fuentes CSS remotas, imágenes de fondo CSS, controladores de
  eventos y atributos de navegación. No se inserta HTML del correo en el DOM
  de NexoMail. Las imágenes no reciben un encabezado Referer.
- La copia de seguridad y la configuración de PostgreSQL no cambian.

## Límites

No es una reproducción exacta de Gmail u Outlook: las fuentes externas,
interacciones, imágenes CID y ciertos estilos no están disponibles. Los cuerpos
MIME demasiado grandes o almacenados como adjuntos separados pueden quedar
parciales. Gmail conserva hasta 500.000 caracteres entre las partes del cuerpo;
el lector limita el HTML mostrado a 500.000 caracteres. Los avisos de análisis
parcial siguen visibles. Las imágenes se cargan desde su origen, sin el proxy
de imágenes de Gmail. Ninguna vista certifica que el mensaje sea seguro.

Compilaciones de TypeScript, Gmail y Outlook completadas. Pendiente comprobar
la presentación con los mensajes reales del usuario en su navegador.
