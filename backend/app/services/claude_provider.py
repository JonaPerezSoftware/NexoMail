"""Claude (Anthropic) para el asistente.

La app habla en el formato de chat compatible con OpenAI que ya usan Gemini y Ollama. Este módulo lo traduce al
formato de la API de Claude y traduce la respuesta de vuelta, de modo que la extensión no necesita saber qué
proveedor responde.

Claude piensa antes de responder y devuelve bloques de razonamiento firmados. En un turno con herramientas esos
bloques deben volver sin cambios en la siguiente vuelta, y todo lo anterior a ellos (instrucciones, herramientas
y mensajes) debe llegar idéntico. Por eso la respuesta incluye «anthropic_content» (los bloques originales), que la
app devuelve tal cual, y el recorte de contexto nunca toca la parte del turno en curso.
"""
import json

import anthropic

from app.core.config import settings

# Reintento automático en otro modelo de Claude si el modelo principal rechaza una consulta por sus filtros de
# seguridad (un falso positivo no deja al usuario sin respuesta). «drop_block»: si un bloque de razonamiento ya no
# corresponde a la conversación, se descarta en lugar de fallar la consulta.
BETAS = ['server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01']
# Bloques que Claude puede devolver y que la app reenvía sin tocarlos.
ECHO_TYPES = {'text', 'thinking', 'redacted_thinking', 'tool_use', 'fallback'}

_client: anthropic.Anthropic | None = None


def configured() -> bool:
    return bool(settings.ANTHROPIC_API_KEY.get_secret_value().strip()) and bool(settings.ANTHROPIC_MODEL.strip())


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        # La clave solo se lee de backend/.env; el SDK reintenta 429, 5xx y errores de conexión.
        _client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY.get_secret_value(), timeout=120.0, max_retries=2)
    return _client


class ClaudeError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def to_tools(tools: list[dict]) -> list[dict]:
    """OpenAI {type:function, function:{name, description, parameters}} → Claude {name, description, input_schema}."""
    out = []
    for tool in tools:
        fn = tool['function']
        schema = fn.get('parameters') or {'type': 'object', 'properties': {}}
        if schema.get('type') != 'object':
            schema = {'type': 'object', 'properties': {}}
        out.append({'name': fn['name'], 'description': fn.get('description', ''), 'input_schema': schema})
    return out


def _echoed(blocks) -> list[dict] | None:
    """The original blocks of an earlier Claude reply, sent back by the app. Only known block types pass."""
    if not isinstance(blocks, list) or not blocks:
        return None
    if not all(isinstance(b, dict) and b.get('type') in ECHO_TYPES for b in blocks):
        return None
    return blocks


def to_messages(messages: list[dict]) -> tuple[str, list[dict]]:
    """Splits the system text from the conversation and converts each turn to Claude's content blocks.
    Consecutive tool results go together in one user message, as the API expects."""
    system_parts: list[str] = []
    out: list[dict] = []
    for message in messages:
        role = message['role']
        content = message.get('content')
        if role == 'system':
            if not out:
                if content:
                    system_parts.append(content)
            else:
                # Later instructions keep their place in the conversation (only the app's first message is system today).
                out.append({'role': 'user', 'content': [{'type': 'text', 'text': '[Instrucción del sistema] ' + (content or '')}]})
            continue
        if role == 'tool':
            block = {'type': 'tool_result', 'tool_use_id': message.get('tool_call_id', ''), 'content': content or ''}
            if out and out[-1]['role'] == 'user' and isinstance(out[-1]['content'], list) and out[-1]['content'] and out[-1]['content'][-1].get('type') == 'tool_result':
                out[-1]['content'].append(block)
            else:
                out.append({'role': 'user', 'content': [block]})
            continue
        if role == 'assistant':
            original = _echoed(message.get('anthropic_content'))
            if original is not None:
                out.append({'role': 'assistant', 'content': original})
                continue
            blocks: list[dict] = []
            if content:
                blocks.append({'type': 'text', 'text': content})
            for call in message.get('tool_calls') or []:
                fn = call.get('function') or {}
                try:
                    args = json.loads(fn.get('arguments') or '{}')
                except (TypeError, ValueError):
                    args = {}
                blocks.append({'type': 'tool_use', 'id': call.get('id', ''), 'name': fn.get('name', ''), 'input': args if isinstance(args, dict) else {}})
            if blocks:
                out.append({'role': 'assistant', 'content': blocks})
            continue
        out.append({'role': 'user', 'content': [{'type': 'text', 'text': content or ''}]})
    if not out or out[0]['role'] != 'user':
        out.insert(0, {'role': 'user', 'content': [{'type': 'text', 'text': '(inicio de la conversación)'}]})
    return '\n\n'.join(system_parts), out


def from_response(response) -> dict:
    """Claude's reply → the chat message the app already understands, plus the original blocks for the next round."""
    data = response.to_dict()
    blocks = data.get('content') or []
    text = '\n\n'.join(b.get('text', '') for b in blocks if b.get('type') == 'text' and b.get('text')).strip()
    calls = [{'id': b['id'], 'type': 'function', 'function': {'name': b['name'], 'arguments': json.dumps(b.get('input') or {}, ensure_ascii=False)}}
             for b in blocks if b.get('type') == 'tool_use']
    stop = data.get('stop_reason')
    if stop == 'refusal' and not calls:
        text = 'Claude no pudo responder a esta consulta por sus políticas de seguridad. Prueba a reformularla.'
    elif stop == 'max_tokens' and not text and not calls:
        raise ClaudeError(502, 'La respuesta de Claude superó el límite de longitud. Sube ANTHROPIC_MAX_TOKENS en backend/.env.')
    message = {'role': 'assistant', 'content': text or None}
    if calls:
        message['tool_calls'] = calls
        # Needed only while the tool round continues; a final answer goes to the history as plain text.
        message['anthropic_content'] = [b for b in blocks if b.get('type') in ECHO_TYPES]
    usage = data.get('usage') or {}
    return {'message': message, 'model': data.get('model', settings.ANTHROPIC_MODEL),
            'usage': {k: usage.get(k) for k in ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens') if usage.get(k) is not None}}


def _params(messages: list[dict], tools: list[dict]) -> dict:
    system, converted = to_messages(messages)
    params = dict(
        model=settings.ANTHROPIC_MODEL,
        max_tokens=settings.ANTHROPIC_MAX_TOKENS,
        messages=converted,
        betas=BETAS,
        fallbacks='default',
        thinking={'type': 'adaptive', 'block_binding': {'prefix_mismatch_behavior': 'drop_block'}},
        output_config={'effort': settings.ANTHROPIC_EFFORT},
        # Caches everything up to the last message: the next round of the same turn rereads it at a fraction of the price.
        cache_control={'type': 'ephemeral'},
    )
    if system:
        # Its own cache point: the instructions and the inbox stay the same between questions, so the next question
        # reads them from cache (faster first token, a fraction of the price) even though the conversation grew.
        params['system'] = [{'type': 'text', 'text': system, 'cache_control': {'type': 'ephemeral'}}]
    if tools:
        params['tools'] = to_tools(tools)
    return params


def _translate(error: Exception) -> ClaudeError:
    """API errors → a message in Spanish for the app. The key never appears in them."""
    if isinstance(error, anthropic.AuthenticationError):
        return ClaudeError(502, 'La clave de Anthropic no es válida o fue revocada. Revisa ANTHROPIC_API_KEY en backend/.env.')
    if isinstance(error, anthropic.PermissionDeniedError):
        return ClaudeError(502, 'La clave de Anthropic no tiene permiso para este modelo.')
    if isinstance(error, anthropic.NotFoundError):
        return ClaudeError(502, f'El modelo {settings.ANTHROPIC_MODEL} no existe o no está disponible en tu cuenta.')
    if isinstance(error, anthropic.RateLimitError):
        return ClaudeError(429, 'Claude limitó temporalmente las consultas de tu cuenta. Espera un momento y vuelve a intentarlo.')
    if isinstance(error, anthropic.BadRequestError):
        text = str(getattr(error, 'message', '') or '')
        if 'credit' in text.lower() or 'billing' in text.lower():
            return ClaudeError(402, 'Tu cuenta de Anthropic no tiene créditos. Recarga en platform.claude.com (Gastos y uso).')
        return ClaudeError(502, 'La API de Claude rechazó la consulta: ' + text[:300])
    if isinstance(error, anthropic.APIStatusError):
        return ClaudeError(502, f'La API de Claude no respondió correctamente (HTTP {error.status_code}). Inténtalo de nuevo.')
    if isinstance(error, anthropic.APIConnectionError):
        return ClaudeError(502, 'No se pudo conectar con la API de Claude. Comprueba tu conexión a internet.')
    return ClaudeError(502, 'No se pudo completar la consulta a Claude.')


def complete(messages: list[dict], tools: list[dict]) -> dict:
    try:
        response = client().beta.messages.create(**_params(messages, tools))
    except anthropic.AnthropicError as error:
        raise _translate(error) from None
    return from_response(response)


def stream(messages: list[dict], tools: list[dict]):
    """Same request, streamed: yields {"type":"text"} pieces as Claude writes the answer, then {"type":"done"} with
    the same result complete() returns. Thinking and tool calls are not shown while they arrive."""
    try:
        with client().beta.messages.stream(**_params(messages, tools)) as events:
            for text in events.text_stream:
                if text:
                    yield {'type': 'text', 'text': text}
            final = events.get_final_message()
    except anthropic.AnthropicError as error:
        raise _translate(error) from None
    yield {'type': 'done', 'result': from_response(final)}
