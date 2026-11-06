# NexoMail · Asistente de correo con IA para Gmail y Outlook

**Versión actual: 1.10.0** · Extensión de navegador (Manifest V3) para Chrome, Edge y Brave.

NexoMail añade un asistente de inteligencia artificial dentro de Gmail y Outlook web. Puede leer, resumir, buscar, clasificar, redactar, enviar, mover a la papelera y recuperar correos a partir de instrucciones en lenguaje natural. **Ninguna acción sensible se ejecuta sin tu aprobación** (modelo *human-in-the-loop*).

> Proyecto de tesis de **Marlon Aguiño** y **Jonathan Pérez**.

---

## Contenido

1. [Características](#características)
2. [Cómo funciona](#cómo-funciona)
3. [Tecnologías](#tecnologías)
4. [Estructura del proyecto](#estructura-del-proyecto)
5. [Requisitos](#requisitos)
6. [Instalación](#instalación)
7. [Uso](#uso)
8. [Seguridad y privacidad](#seguridad-y-privacidad)
9. [Servidor local: API](#servidor-local-api)
10. [Base de datos](#base-de-datos)
11. [Desarrollo](#desarrollo)
12. [Problemas frecuentes](#problemas-frecuentes)
13. [Limitaciones conocidas](#limitaciones-conocidas)
14. [Historial de versiones](#historial-de-versiones)
15. [Autores y licencias](#autores-y-licencias)

---

## Características

### Una sola interfaz para dos correos
Gmail y Outlook usan **exactamente la misma aplicación**. Solo cambia la pieza que se comunica con cada proveedor: la API de Gmail o Microsoft Graph.

### Panel flotante dentro del correo
- Una burbuja en Gmail y Outlook web abre una ventana flotante que se puede mover, cambiar de tamaño, minimizar o ampliar a pantalla completa.
- La posición y el tamaño se recuerdan para cada plataforma.
- El icono de la barra del navegador abre o minimiza la misma ventana.

### Cinco secciones
| Sección | Qué hace |
|---|---|
| **Chat** | Conversación con el agente. Cada mensaje muestra fecha y hora, y una flecha baja al último mensaje. El botón **Sugerencias** ofrece acciones rápidas, y se pueden adjuntar archivos. Si la consulta usa IA, se puede ver el paso a paso de cómo la resolvió. |
| **Correo** | Bandeja con carpetas (Entrada, Enviados, Borradores guardados, Destacados, Todos, Papelera), búsqueda, filtros por categoría y lector seguro de HTML. Desde aquí también se redacta un correo nuevo, se responde (a mano o con IA), se clasifica a mano y se recupera de la papelera. |
| **Acciones** | Propuestas del agente pendientes de aprobación. Se pueden **editar** antes de aprobar, incluido añadir o quitar adjuntos. |
| **Historial** | Auditoría de todo lo consultado, propuesto, aprobado, rechazado o fallido. Se puede buscar, filtrar por tipo y **por fecha** (hoy, 7 días, 30 días o un rango), y exportar a JSON. |
| **Ajustes** | Cuenta conectada, tema claro u oscuro, revisión estricta, estado de la IA, datos guardados y permisos concedidos. |

### Agente de IA con dos motores
- **IA (LLM):** Google Gemini u Ollama local, con *tool calling*. El modelo decide qué herramienta usar.
- **Motor de reglas local:** se usa cuando no hay IA configurada o cuando la IA falla (por ejemplo, un error 503 por saturación). Así el asistente sigue funcionando.

### Herramientas del agente
`search_emails`, `get_email_details`, `list_priority_emails`, `prepare_send_email`, `prepare_label_emails`, `prepare_delete_emails`, `prepare_restore_emails` y `prepare_bulk_cleanup`.

Las herramientas `prepare_*` **no ejecutan nada**: crean una propuesta en **Acciones**.

### Seguridad del contenido
El análisis de cada correo detecta señales de riesgo, como enlaces engañosos, remitentes sospechosos o solicitudes de pago. El HTML se muestra aislado y las imágenes remotas están bloqueadas hasta que las permitas.

### Persistencia opcional
Con PostgreSQL se guardan, por cuenta, el chat, los borradores, las preferencias y el historial.

---

## Cómo funciona

```mermaid
flowchart TD
    Page[Gmail u Outlook web] --> CS[content.js: burbuja y ventana flotante]
    CS --> Frame[floating.html: pestañas]
    Frame --> UI[App React: una interfaz para ambos correos]
    UI --> MP{mailProvider}
    MP -->|versión Gmail| GA[Gmail API con OAuth de Google]
    MP -->|versión Outlook| MG[Microsoft Graph con MSAL y PKCE]
    UI --> Agent[Agente: IA o motor de reglas]
    Agent --> API[Servidor FastAPI en 127.0.0.1:8000]
    API --> LLM[Gemini u Ollama]
    UI --> Store[Almacenamiento por cuenta]
    Store --> API
    API --> DB[(PostgreSQL)]
```

### Flujo de una petición
1. **Escribes una instrucción**, por ejemplo «Envíale un correo a ana@ejemplo.com diciendo que llego tarde».
2. **El agente detecta la intención.** Las eliminaciones y recuperaciones pasan por rutas deterministas que buscan los correos exactos en el buzón real.
3. **Si hay IA configurada**, el servidor local envía al modelo tu petición, un extracto de los correos cargados y las herramientas disponibles. El modelo responde con llamadas a herramientas.
4. **Los *guardrails*** validan cada acción: destinatario válido, que la petición coincida con la acción (una orden de borrar nunca acaba en un envío), sesión y cuenta correctas.
5. **Las acciones sensibles** (enviar, borrar, recuperar y, con revisión estricta, etiquetar) quedan en **Acciones** hasta que pulses Aprobar.
6. **Al aprobar**, la app llama directamente a la API de Gmail o de Graph con el permiso de tu cuenta. El resultado queda en el **Historial**.

### Una app, dos compilaciones
El código está en `apps/gmail/` y se compila dos veces con Vite:

| Modo | Archivo de entorno | Salida | Proveedor |
|---|---|---|---|
| Gmail | `apps/gmail/.env` (`VITE_PLATFORM=gmail`) | `extension/apps/gmail/` | `realGmailProvider.ts` |
| Outlook | `apps/gmail/.env.outlook` (`VITE_PLATFORM=outlook`) | `extension/apps/outlook/` | `outlookProvider.ts` |

`src/services/mailProvider.ts` define la interfaz común: leer, buscar, enviar, mover a la papelera, recuperar, etiquetar y marcar como leído. El agente usa la sintaxis de búsqueda de Gmail (`in:sent`, `from:`, `subject:`…). El adaptador de Outlook la traduce a carpetas de Graph y a consultas KQL.

---

## Tecnologías

### Extensión
| Tecnología | Uso |
|---|---|
| Chrome Extensions **Manifest V3** | Service worker, content scripts, página de opciones y CSP estricta |
| JavaScript (ES modules) | `content.js`, `floating.js`, `background.js`, `google-auth.js`, `microsoft-session.js` |
| Shadow DOM | Aísla la burbuja y la ventana de los estilos de Gmail y Outlook |
| `chrome.identity` | Ventanas de inicio de sesión de Google y Microsoft |
| `chrome.storage` | Configuración pública y sesiones temporales |

### Interfaz
| Tecnología | Versión | Uso |
|---|---|---|
| React | 19 | Interfaz de usuario |
| TypeScript | 6 | Tipado |
| Vite | 8 | Compilación (dos modos) |
| lucide-react | 1.x | Iconos |
| @fontsource-variable/inter | 5 | Tipografía Inter, incluida en el paquete |
| @azure/msal-browser | 3.25 | Inicio de sesión de Microsoft (PKCE) |
| oxlint | 1.x | Análisis estático |

### Servidor local
| Tecnología | Uso |
|---|---|
| Python 3.12 | Lenguaje |
| FastAPI + Uvicorn | API local en `127.0.0.1:8000` |
| Pydantic / pydantic-settings | Validación y configuración desde `backend/.env` |
| psycopg 3 | Conexión a PostgreSQL |

### Servicios externos
| Servicio | Uso |
|---|---|
| Gmail API | Leer y gestionar correo de Gmail |
| Microsoft Graph | Leer y gestionar correo de Outlook y Hotmail |
| Google Gemini | Modelo de IA en la nube (opcional) |
| Ollama | Modelo de IA local (opcional) |
| PostgreSQL 14 o superior | Persistencia (opcional) |

---

## Estructura del proyecto

```
Nexo-Mail/
├── apps/gmail/                 Interfaz React única (se compila para Gmail y Outlook)
│   ├── .env / .env.outlook     Elige el proveedor al compilar
│   └── src/
│       ├── App.tsx             Estado global, navegación y aprobación de acciones
│       ├── components/         Chat, Correo, Acciones, Historial, Ajustes, redacción…
│       └── services/
│           ├── agentEngine.ts       Agente: IA con herramientas y motor de reglas
│           ├── agentTools.ts        Definición y ejecución de herramientas
│           ├── guardrails.ts        Reglas de seguridad de las propuestas
│           ├── mailIntent.ts        Detección de intención y búsqueda de correos
│           ├── mailProvider.ts      Interfaz común de proveedor
│           ├── realGmailProvider.ts Adaptador de la API de Gmail
│           ├── outlookProvider.ts   Adaptador de Microsoft Graph (MSAL)
│           ├── platform.ts          Nombre, límites y textos según el proveedor
│           └── dates.ts             Fechas del chat y del historial
├── shared/                     Código común
│   ├── mail/                   Análisis de riesgo, documento seguro y textos del chat
│   ├── storage/                Cliente de almacenamiento por cuenta
│   └── styles/                 Estilos compartidos (nexo-ui.css)
├── extension/                  Extensión lista para cargar en el navegador
│   ├── manifest.json
│   ├── content.js / floating.* Burbuja y ventana flotante
│   ├── background.js           Service worker
│   ├── google-auth.js          Sesión de Google
│   ├── microsoft-session.js    Sesión temporal de Microsoft
│   ├── options.*               Página de opciones
│   ├── privacy.html            Política de privacidad
│   ├── config.json             Valores públicos por defecto
│   └── apps/                   Generado por la compilación (no se versiona)
├── backend/                    Servidor FastAPI
│   ├── .env.example            Plantilla de configuración (sin secretos)
│   └── app/
│       ├── api/                gmail.py (IA), storage.py (datos), health.py
│       ├── core/config.py      Configuración
│       ├── services/llm_retry.py Reintentos ante saturación del proveedor
│       └── storage/            Conexión y esquema de PostgreSQL
├── scripts/                    build.mjs y configuración inicial
├── docs/ARQUITECTURA.md        Decisiones técnicas
├── CONFIGURAR_SERVIDOR.cmd     Prepara el servidor (una vez)
├── CONFIGURAR_BASE_DATOS.cmd   Conecta PostgreSQL (una vez, opcional)
├── INICIAR_SERVIDOR.cmd        Arranca el servidor (cada día)
└── RECOMPILAR.cmd              Compila la interfaz
```

---

## Requisitos

| Requisito | Para qué |
|---|---|
| Chrome 116+, Edge o Brave | Ejecutar la extensión |
| Python 3.12 | Servidor local de IA |
| Node.js 24 | Compilar la interfaz (`RECOMPILAR.cmd`) |
| Cuenta de Google Cloud con Gmail API | Conectar Gmail |
| Registro de aplicación en Microsoft Entra | Conectar Outlook |
| Clave de Gemini **u** Ollama instalado | Respuestas con IA (sin ellos se usa el motor de reglas) |
| PostgreSQL 14+ | Opcional: guardar chat, borradores e historial |

---

## Instalación

### 1. Preparar el servidor
1. Ejecuta **`CONFIGURAR_SERVIDOR.cmd`**. Crea `backend/.venv`, instala las dependencias y genera `backend/.env` con una **clave de enlace** aleatoria. Si `.env` ya existe, no lo modifica.
2. Edita **`backend/.env`**:
   - **Gemini:** `LLM_PROVIDER=gemini`, `LLM_MODEL=<modelo disponible en tu cuenta>`, `GEMINI_API_KEY=<tu clave>`.
   - **Ollama:** `LLM_PROVIDER=ollama`, `LLM_MODEL=<modelo descargado>`, `OLLAMA_URL=http://127.0.0.1:11434`.
   - Ajustes opcionales: `LLM_MESSAGE_LIMIT`, `LLM_MAX_OUTPUT_TOKENS` y `LLM_CONTEXT_CHARS`.

### 2. Base de datos (opcional)
1. En PostgreSQL, crea el usuario `nexomail_app` y la base `nexomail`.
2. Ejecuta **`CONFIGURAR_BASE_DATOS.cmd`**. Te pide el puerto y la contraseña de `nexomail_app` (no se muestra al escribirla), crea las tablas y guarda la conexión en `backend/.env`.

### 3. Compilar la interfaz
Ejecuta **`RECOMPILAR.cmd`**. Instala las dependencias de `apps/gmail` y genera `extension/apps/gmail` y `extension/apps/outlook`.

### 4. Cargar la extensión
1. Abre `chrome://extensions` (o `edge://extensions` o `brave://extensions`).
2. Activa el **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y elige la carpeta **`extension`**, la que contiene `manifest.json`.
4. Fija el icono de NexoMail en la barra del navegador.

### 5. Configurar las opciones
Abre las **opciones** de NexoMail. Desde la ficha de la extensión, el engranaje de la ventana flotante o Ajustes, pulsa **Opciones de la extensión**.

| Campo | Dónde se obtiene |
|---|---|
| **Clave de enlace** | Valor `EXTENSION_ACCESS_TOKEN` de `backend/.env` |
| **Google OAuth Client ID** | Google Cloud → Credenciales → cliente OAuth de tipo *aplicación web* |
| **Microsoft Application (client) ID** | Microsoft Entra → Registros de aplicaciones |
| **Cuentas que pueden entrar** | Personales y de organizaciones (recomendado), solo personales o solo de organizaciones |

Pulsa **Guardar cambios** y luego **Comprobar conexión** con el servidor iniciado.

### 6. Registrar las direcciones de retorno
Las opciones muestran dos direcciones con botón **Copiar**:

- **Google:** `https://<ID_EXTENSION>.chromiumapp.org/google`. Regístrala en el cliente OAuth como URI de redireccionamiento autorizado. Si la app de Google está en pruebas, añade tu correo como usuario de prueba.
- **Microsoft:** `https://<ID_EXTENSION>.chromiumapp.org/microsoft`. Regístrala en Microsoft Entra → Autenticación → **Aplicación de página única (SPA)**.

> El ID de la extensión cambia si la cargas en otro navegador o la reinstalas. En ese caso, registra de nuevo las dos direcciones.

### 7. Arrancar y usar
1. Ejecuta **`INICIAR_SERVIDOR.cmd`** y deja la ventana abierta.
2. Abre Gmail u Outlook web, pulsa la burbuja de NexoMail y conecta tu cuenta.

---

## Uso

### Primer inicio
1. Abre `mail.google.com` u Outlook web (`outlook.live.com`, `outlook.office.com`, `outlook.office365.com` o `outlook.cloud.microsoft`).
2. Pulsa la **burbuja** de NexoMail.
3. Acepta el **aviso de privacidad** (solo la primera vez) y autoriza tu cuenta con Google o Microsoft.

Sin conectar una cuenta, la app funciona en **modo demostración** con correos de ejemplo.

### Ejemplos de instrucciones
- «Hazme un resumen de los correos urgentes de hoy»
- «Resume mis correos no leídos»
- «Redacta una respuesta al correo seleccionado»
- «Envíale un correo a ana@ejemplo.com que diga que la reunión se mueve al jueves»
- «Elimina el correo de PayPhone»
- «Recupera de la papelera el correo de Jira»
- «Etiqueta como Trabajo los correos sin leer del proyecto»

### Aprobar acciones
En **Acciones** revisa cada propuesta. Puedes **Editar** el destinatario, el asunto, el mensaje y los adjuntos, **Rechazar** o **Aprobar**.

- **Enviar** y **mover a la papelera** siempre requieren aprobación.
- **Etiquetar** también la requiere si activas *Revisión estricta* en Ajustes.

### Adjuntos
Se pueden adjuntar archivos desde el chat, al redactar o al editar una propuesta. El límite es de **20 MB** por mensaje en Gmail y **3 MB** en Outlook (límite de Graph para envíos directos). La IA solo ve los **nombres** de los archivos, nunca su contenido.

### Clasificación manual
En **Correo** puedes asignar una categoría: Trabajo, Personal, Importante, Finanzas o Boletines.
- En Gmail se guarda como una **etiqueta real** de Gmail.
- En Outlook se guarda como una **categoría** de Outlook.

La categoría manual tiene prioridad sobre la agrupación automática.

---

## Seguridad y privacidad

- **Aprobación humana:** nada se envía, borra o mueve sin tu aprobación. Los intentos fallidos no se repiten automáticamente.
- **Sin secretos en el navegador:**
  - Google y Microsoft se autorizan sin *Client Secret*. Microsoft usa PKCE.
  - Los tokens de acceso viven en el almacenamiento de **sesión** de la extensión.
- **Claves de IA solo en el servidor:** `GEMINI_API_KEY` está únicamente en `backend/.env`.
- **Servidor cerrado al exterior:**
  - Escucha solo en `127.0.0.1`.
  - Acepta solo orígenes `chrome-extension://`.
  - Exige la cabecera `X-EmailAgent-Token` (la clave de enlace), que se compara en tiempo constante.
- **Identidad verificada:** el almacenamiento identifica la cuenta a partir de un token validado con Google o Microsoft, nunca de un correo enviado por el cliente.
- **Cuenta de la página:** NexoMail comprueba que la cuenta autorizada coincida con la abierta en la pestaña.
- **Contenido aislado:**
  - El HTML de los correos se muestra en un documento aislado y sin scripts.
  - Las imágenes remotas se bloquean salvo que las permitas.
  - Los enlaces piden confirmación.
- **CSP estricta (Manifest V3):** no se carga código remoto y las fuentes van incluidas en el paquete.
- **Qué recibe la IA:** tu petición y extractos de los correos cargados. Revisa la política del proveedor de IA que uses. Con Ollama, todo se procesa en tu equipo.

Más detalles en [`extension/privacy.html`](extension/privacy.html) y [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

### Qué no debe subirse a un repositorio
`backend/.env` (claves y contraseñas), `DEPLOY_DATABASE.sql` (contiene una contraseña), `backend/.venv/`, `node_modules/` y `extension/apps/`. Todos están en `.gitignore`.

---

## Servidor local: API

Todas las rutas requieren la cabecera `X-EmailAgent-Token`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado del servidor (lo usa **Comprobar conexión**) |
| GET | `/api/gmail/agent/health` | Proveedor y modelo de IA configurados |
| POST | `/api/gmail/agent/chat` | Consulta al modelo con herramientas. Reintenta ante errores 503 y 529 de saturación. Gmail y Outlook la usan por igual. |
| GET | `/api/storage/{gmail\|microsoft}/workspace` | Carga el chat, los borradores, las preferencias y el historial de la cuenta |
| POST | `/api/storage/{provider}/workspace/{section}` | Guarda una sección con control de versiones |
| POST | `/api/storage/{provider}/audit` | Añade eventos al historial |
| POST | `/api/storage/{provider}/erase` | Borra todos los datos guardados de la cuenta |

Las rutas `/api/storage/*` exigen además `Authorization: Bearer <token de Google o Microsoft>` para identificar la cuenta.

---

## Base de datos

Esquema `nexomail` en PostgreSQL. Se crea con `CONFIGURAR_BASE_DATOS.cmd` a partir de `backend/app/storage/schema.sql`.

| Tabla | Contenido |
|---|---|
| `tbl_mae_cuentas` | Cuentas (proveedor, identificador verificado, correo) |
| `tbl_cfg_preferencias_usuario` | Tema, revisión estricta y agrupación automática |
| `tbl_tra_mensajes_chat` | Mensajes recientes del chat |
| `tbl_tra_borradores` | Borradores guardados |
| `tbl_tra_versiones_espacio` | Versiones de cada sección, para evitar sobrescrituras |
| `tbl_aud_eventos` | Historial de auditoría |
| `tbl_sis_migraciones` | Control de versiones del esquema |

No se guardan correos, tokens ni adjuntos. Las propuestas pendientes no se restauran al recargar, por seguridad.

---

## Desarrollo

### Scripts
| Archivo | Cuándo usarlo |
|---|---|
| `CONFIGURAR_SERVIDOR.cmd` | Una vez por equipo, o si borras `backend/.venv` |
| `CONFIGURAR_BASE_DATOS.cmd` | Una vez, o si cambia la contraseña o el puerto de PostgreSQL |
| `RECOMPILAR.cmd` | Cada vez que cambie el código de `apps/` o `shared/` |
| `INICIAR_SERVIDOR.cmd` | Cada vez que uses el asistente. Reinícialo si cambias `backend/.env` |

Si solo cambias archivos de `extension/` (por ejemplo `options.html` o `content.js`), basta con **Recargar** la extensión.

### Compilar a mano
```bash
cd apps/gmail
npm ci
cd ../..
node scripts/build.mjs
```

`build.mjs` ejecuta `tsc -b`, luego `vite build` (Gmail) y `vite build --mode outlook` (Outlook).

### Añadir un proveedor de correo
Implementa la interfaz `MailProvider` de `apps/gmail/src/services/mailProvider.ts`, añade el modo en `platform.ts` y crea su archivo `.env.<modo>`.

---

## Problemas frecuentes

| Situación | Solución |
|---|---|
| No aparece la burbuja | Recarga la pestaña del correo después de instalar o actualizar la extensión. |
| `redirect_uri_mismatch` o error de `redirect_uri` | Copia la dirección exacta desde las opciones y regístrala (Google: aplicación web; Microsoft: SPA). |
| «Acceso bloqueado» en Google | Añade tu correo como usuario de prueba o publica la app en Google Auth Platform. |
| Microsoft no termina de conectar | Revisa el Client ID, el tipo de cuenta y la dirección SPA. Algunas organizaciones exigen la aprobación de un administrador. |
| «No hay conexión» con el servidor | Ejecuta `INICIAR_SERVIDOR.cmd` y comprueba que la clave de enlace coincide con `backend/.env`. |
| Error 503 «high demand» de Gemini | Es saturación temporal de Google. El servidor reintenta y, si sigue fallando, responde el motor de reglas. |
| No veo los cambios tras actualizar | Ejecuta `RECOMPILAR.cmd`, pulsa **Recargar** en `chrome://extensions` y recarga la pestaña. |
| Correo «aceptado» pero no recibido | Que el proveedor acepte el envío no garantiza la entrega. Revisa la bandeja de entrada por si hay avisos de rebote. |
| Outlook: un correo no se marca como leído | Falta el permiso de escritura. Se concede la primera vez que apruebas una acción en Outlook. |

---

## Limitaciones conocidas

- No está publicada en la Chrome Web Store. Se instala en modo desarrollador.
- El servidor de IA es local: cada equipo necesita el suyo, o un servicio alojado preparado para varios usuarios.
- Mientras la app de Google esté en pruebas, solo entran sus usuarios de prueba.
- Outlook admite como máximo 3 MB de adjuntos por mensaje.
- No hay aviso automático de correos rebotados en Outlook ni paginación «Cargar más».
- El correo seleccionado en la página de Gmail u Outlook no se sincroniza con el panel: se elige dentro de NexoMail.

---

## Historial de versiones

| Versión | Cambios principales |
|---|---|
| **1.10.0** | Una sola interfaz React para Gmail y Outlook (se retira la app Angular). Nueva página de opciones, botón Sugerencias, flecha al último mensaje, fecha en el chat, filtro por fecha en Historial, adjuntos al editar propuestas, listas legibles en modo oscuro y botones del panel sin contorno residual. |
| 1.9.x | Rediseño premium y responsive, tipografía Inter, recuperar de la papelera, clasificación manual, adjuntos desde el chat, política de privacidad, paso a paso del agente, chat que abre en el último mensaje, eliminación segura (sin envíos accidentales), reintentos ante el 503 de Gemini y lector de correos con formato. |
| 1.8.x | Persistencia opcional con PostgreSQL, recuperación de la sesión al recargar y autorización directa con Google. |
| 1.2 – 1.7 | Ventana flotante sin Side Panel API, integración de los proyectos de Gmail y Outlook en una sola extensión, servidor de IA compartido y cuentas personales e institucionales de Microsoft. |

---

## Autores y licencias

**Marlon Aguiño** · **Jonathan Pérez**. Proyecto de tesis.

Las licencias de terceros incluidas en el paquete están en [`extension/licenses/`](extension/licenses/): React, React DOM, Lucide, MSAL Browser e Inter.
