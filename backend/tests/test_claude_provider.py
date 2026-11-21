"""Pruebas del adaptador de Claude sin llamar a la API (no gastan créditos).
Ejecutar desde backend/:  .venv\\Scripts\\python.exe tests\\test_claude_provider.py
"""
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.services import claude_provider as cp  # noqa: E402
from app.api import gmail  # noqa: E402

fails = 0
sys.stdout.reconfigure(encoding="utf-8")


def check(name, ok, info=''):
    global fails
    if not ok:
        fails += 1
    print(('OK   ' if ok else 'FALLO') + ' ' + name + ('' if ok else ' -> ' + str(info)))


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def to_dict(self):
        return copy.deepcopy(self.data)


class FakeClient:
    """Records each request and answers with the next prepared reply."""
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []
        fake = self

        class Msgs:
            def create(self, **params):
                fake.calls.append(copy.deepcopy(params))
                return FakeResponse(fake.replies.pop(0))

        class Beta:
            messages = Msgs()

        self.beta = Beta()


TOOLS = [{'type': 'function', 'function': {'name': 'search_emails', 'description': 'Busca correos', 'parameters': {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query']}}}]
TOOL_REPLY = {'model': 'claude-opus-5-5', 'stop_reason': 'tool_use', 'usage': {'input_tokens': 1200, 'output_tokens': 80, 'cache_read_input_tokens': 0},
              'content': [{'type': 'thinking', 'thinking': '', 'signature': 'sig-abc'},
                          {'type': 'tool_use', 'id': 'toolu_1', 'name': 'search_emails', 'input': {'query': 'Pichincha'}}]}
FINAL_REPLY = {'model': 'claude-opus-5-5', 'stop_reason': 'end_turn', 'usage': {'input_tokens': 300, 'output_tokens': 40, 'cache_read_input_tokens': 1100},
               'content': [{'type': 'thinking', 'thinking': '', 'signature': 'sig-def'}, {'type': 'text', 'text': 'Tienes 2 correos de Pichincha.'}]}

print('— Traducción de mensajes')
system, msgs = cp.to_messages([
    {'role': 'system', 'content': 'Instrucciones y bandeja'},
    {'role': 'user', 'content': 'Hola'},
    {'role': 'assistant', 'content': 'Hola, ¿qué necesitas?'},
    {'role': 'user', 'content': 'Busca Pichincha'},
    {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'a', 'type': 'function', 'function': {'name': 'search_emails', 'arguments': '{"query":"x"}'}},
                                                          {'id': 'b', 'type': 'function', 'function': {'name': 'search_emails', 'arguments': '{"query":"y"}'}}]},
    {'role': 'tool', 'tool_call_id': 'a', 'content': 'r1'},
    {'role': 'tool', 'tool_call_id': 'b', 'content': 'r2'},
])
check('Las instrucciones van en «system»', system == 'Instrucciones y bandeja', system)
check('Los turnos se convierten en orden', [m['role'] for m in msgs] == ['user', 'assistant', 'user', 'assistant', 'user'], [m['role'] for m in msgs])
check('Las llamadas a herramientas pasan a tool_use con sus argumentos', [b['input'] for b in msgs[3]['content']] == [{'query': 'x'}, {'query': 'y'}], msgs[3])
check('Varios resultados de herramientas van juntos en un solo mensaje', [b['tool_use_id'] for b in msgs[4]['content']] == ['a', 'b'], msgs[4])
_, echoed = cp.to_messages([{'role': 'user', 'content': 'x'}, {'role': 'assistant', 'content': None, 'tool_calls': [], 'anthropic_content': TOOL_REPLY['content']}])
check('Los bloques originales de Claude (con su razonamiento) se reenvían sin cambios', echoed[1]['content'] == TOOL_REPLY['content'], echoed[1])
_, bad = cp.to_messages([{'role': 'user', 'content': 'x'}, {'role': 'assistant', 'content': 'hola', 'anthropic_content': [{'type': 'otro'}]}])
check('Bloques de un tipo desconocido no se aceptan', bad[1]['content'] == [{'type': 'text', 'text': 'hola'}], bad[1])
check('Herramientas: parameters → input_schema', cp.to_tools(TOOLS)[0]['input_schema']['required'] == ['query'])

print('\n— Respuesta de Claude → formato de la app')
out = cp.from_response(FakeResponse(TOOL_REPLY))
check('tool_use → tool_calls con argumentos en JSON', json.loads(out['message']['tool_calls'][0]['function']['arguments']) == {'query': 'Pichincha'}, out)
check('Incluye los bloques originales para la siguiente vuelta', out['message']['anthropic_content'] == TOOL_REPLY['content'], out)
out = cp.from_response(FakeResponse(FINAL_REPLY))
check('Respuesta final: solo el texto, sin bloques internos', out['message'] == {'role': 'assistant', 'content': 'Tienes 2 correos de Pichincha.'}, out)
out = cp.from_response(FakeResponse({'stop_reason': 'refusal', 'content': [], 'usage': {}}))
check('Un rechazo da un mensaje claro en español', 'políticas de seguridad' in (out['message']['content'] or ''), out)
try:
    cp.from_response(FakeResponse({'stop_reason': 'max_tokens', 'content': [{'type': 'thinking', 'thinking': '', 'signature': 's'}], 'usage': {}}))
    check('Sin texto por límite de longitud → error explicado', False)
except cp.ClaudeError as error:
    check('Sin texto por límite de longitud → error explicado', 'ANTHROPIC_MAX_TOKENS' in error.detail, error.detail)

print('\n— Turno completo con herramientas (servidor)')
saved = (settings.LLM_PROVIDER, settings.ANTHROPIC_API_KEY, cp._client)
settings.LLM_PROVIDER = 'anthropic'
settings.ANTHROPIC_API_KEY = type(settings.ANTHROPIC_API_KEY)('sk-ant-prueba-falsa')
fake = FakeClient([TOOL_REPLY, FINAL_REPLY])
cp._client = fake
long_history = [{'role': 'user', 'content': 'pregunta vieja ' * 400}, {'role': 'assistant', 'content': 'respuesta vieja ' * 400}]
round1 = [{'role': 'system', 'content': 'BANDEJA ' * 3000}, *long_history, {'role': 'user', 'content': 'Busca Pichincha'}]
r1 = gmail.complete(gmail.GmailChat(messages=copy.deepcopy(round1), tools=TOOLS))
assistant = r1['message']
round2 = round1 + [{'role': 'assistant', 'content': assistant['content'], 'tool_calls': assistant['tool_calls'], 'anthropic_content': assistant['anthropic_content']},
                   {'role': 'tool', 'tool_call_id': 'toolu_1', 'content': json.dumps({'resultados': ['x' * 9000]})}]
r2 = gmail.complete(gmail.GmailChat(messages=copy.deepcopy(round2), tools=TOOLS))
first, second = fake.calls
check('Usa el modelo, el esfuerzo y la caché configurados', first['model'] == settings.ANTHROPIC_MODEL and first['output_config'] == {'effort': settings.ANTHROPIC_EFFORT} and first['cache_control'] == {'type': 'ephemeral'}, first)
check('Activa el respaldo ante rechazos y el modo «drop_block»', first['fallbacks'] == 'default' and 'server-side-fallback-2026-07-01' in first['betas'] and first['thinking']['block_binding']['prefix_mismatch_behavior'] == 'drop_block', first)
check('La segunda vuelta repite exactamente lo anterior (instrucciones, herramientas y mensajes)',
      second['system'] == first['system'] and first['system'][0]['cache_control'] == {'type': 'ephemeral'} and second['tools'] == first['tools'] and second['messages'][:len(first['messages'])] == first['messages'],
      'el prefijo cambió')
check('…y añade el razonamiento original y el resultado de la herramienta', second['messages'][len(first['messages'])]['content'] == TOOL_REPLY['content'] and second['messages'][-1]['content'][0]['type'] == 'tool_result', second['messages'][-2:])
check('El contexto anterior se recorta al presupuesto configurado', len(first['system'][0]['text']) + sum(len(json.dumps(m, ensure_ascii=False)) for m in first['messages']) < settings.LLM_CONTEXT_CHARS + 3000, len(first['system'][0]['text']))
check('La respuesta final llega como texto normal', r2['message']['content'] == 'Tienes 2 correos de Pichincha.', r2)
check('El estado indica Anthropic Claude', gmail.health()['provider'] == 'Anthropic Claude' and gmail.health()['configured'], gmail.health())

print('\n— Respuesta en directo (streaming)')
class FakeStream:
    def __init__(self, pieces, final):
        self.text_stream = iter(pieces)
        self.final = final
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def get_final_message(self):
        return FakeResponse(self.final)
class StreamClient:
    def __init__(self):
        self.calls = []
        fake = self
        class Msgs:
            def stream(self, **params):
                fake.calls.append(params)
                return FakeStream(['Tienes 2 ', 'correos de ', 'Pichincha.'], FINAL_REPLY)
        class Beta:
            messages = Msgs()
        self.beta = Beta()
cp._client = StreamClient()
lines = [json.loads(line) for line in gmail.stream_events(gmail.GmailChat(messages=[{'role': 'user', 'content': 'hola'}], tools=TOOLS))]
check('El texto llega en trozos mientras Claude escribe', [e['text'] for e in lines if e['type'] == 'text'] == ['Tienes 2 ', 'correos de ', 'Pichincha.'], lines)
check('Al final llega el mismo resultado que sin streaming', lines[-1]['type'] == 'done' and lines[-1]['result']['message']['content'] == 'Tienes 2 correos de Pichincha.', lines[-1])
check('El streaming usa los mismos ajustes (caché, respaldo, esfuerzo)', cp._client.calls[0]['fallbacks'] == 'default' and cp._client.calls[0]['cache_control'] == {'type': 'ephemeral'})

print('\n— Errores')
class Boom:
    class beta:
        class messages:
            @staticmethod
            def stream(**kw):
                return Boom.beta.messages.create(**kw)
            @staticmethod
            def create(**_):
                import anthropic
                import httpx2
                request = httpx2.Request('POST', 'https://api.anthropic.com/v1/messages')
                raise anthropic.AuthenticationError('invalid x-api-key', response=httpx2.Response(401, request=request), body=None)
cp._client = Boom()
try:
    gmail.complete(gmail.GmailChat(messages=[{'role': 'user', 'content': 'hola'}], tools=[]))
    check('Clave inválida → mensaje claro', False)
except HTTPException as error:
    check('Clave inválida → mensaje claro, sin mostrar la clave', 'ANTHROPIC_API_KEY' in error.detail and 'sk-ant' not in error.detail, error.detail)
lines = [json.loads(line) for line in gmail.stream_events(gmail.GmailChat(messages=[{'role': 'user', 'content': 'hola'}], tools=[]))]
check('En directo, un error llega como evento «error» con su explicación', len(lines) == 1 and lines[0]['type'] == 'error' and 'ANTHROPIC_API_KEY' in lines[0]['detail'], lines)

print('\n— Gemini: respuesta completa y en directo')
settings.LLM_PROVIDER = 'gemini'
check('Con Gemini por defecto, el estado muestra Google Gemini', gmail.health()['provider'] == 'Google Gemini', gmail.health())
sent = []
SSE = [
    'data: {"model":"gemini-3.5-flash-lite","choices":[{"delta":{"content":"Hola, "}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"aquí estoy."}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"search_emails","arguments":"{\\"query\\":"}, "extra_content":{"google":{"thought_signature":"firma-1"}}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"empleo\\"}"}}]}}]}',
    'data: [DONE]',
]
def fake_open(req, timeout):
    body = json.loads(req.data)
    sent.append(body)
    class R:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def read(self, n):
            return json.dumps({'choices': [{'message': {'role': 'assistant', 'content': 'ok'}}], 'model': 'g'}).encode()
        def __iter__(self):
            return iter([(line + '\n').encode() for line in SSE])
    return R()
original_open, original_key = gmail.urlopen_with_retry, settings.GEMINI_API_KEY
gmail.urlopen_with_retry = fake_open
settings.GEMINI_API_KEY = type(settings.GEMINI_API_KEY)('clave-falsa')
r = gmail.complete(gmail.GmailChat(messages=[{'role': 'user', 'content': 'hola'}, {'role': 'assistant', 'content': None, 'tool_calls': [], 'anthropic_content': [{'type': 'text', 'text': 'x'}]}, {'role': 'user', 'content': 'sigue'}], tools=[]))
check('Gemini sin streaming sigue funcionando', r['message']['content'] == 'ok', r)
check('A Gemini nunca le llegan los bloques internos de Claude', all('anthropic_content' not in m for m in sent[-1]['messages']), sent[-1]['messages'])
lines = [json.loads(line) for line in gmail.stream_events(gmail.GmailChat(messages=[{'role': 'user', 'content': 'hola'}], tools=TOOLS))]
check('Gemini también responde en directo, por trozos', [e['text'] for e in lines if e['type'] == 'text'] == ['Hola, ', 'aquí estoy.'] and sent[-1].get('stream') is True, lines)
done = lines[-1]['result']['message']
check('…con el texto completo al final', done['content'] == 'Hola, aquí estoy.', done)
call = done['tool_calls'][0]
check('Las llamadas a herramientas en trozos se unen', call['function']['name'] == 'search_emails' and json.loads(call['function']['arguments']) == {'query': 'empleo'} and call['id'] == 'c1', call)
check('La firma de Gemini («extra_content») se conserva para devolverla', call.get('extra_content') == {'google': {'thought_signature': 'firma-1'}}, call)

print('\n— Elegir el modelo en la app')
settings.LLM_PROVIDER = 'anthropic'
settings.ANTHROPIC_API_KEY = type(settings.ANTHROPIC_API_KEY)('sk-ant-prueba-falsa')
cp._client = StreamClient()
lines = [json.loads(line) for line in gmail.stream_events(gmail.GmailChat(messages=[{'role': 'user', 'content': 'hola'}], tools=TOOLS, provider='gemini'))]
check('Elegir Gemini en la app lo usa aunque el servidor tenga Claude por defecto', sent[-1]['model'].startswith('gemini') and lines[-1]['result']['message']['content'] == 'Hola, aquí estoy.', sent[-1].get('model'))
before = len(cp._client.calls)
lines = [json.loads(line) for line in gmail.stream_events(gmail.GmailChat(messages=[{'role': 'user', 'content': 'hola'}], tools=TOOLS, provider='anthropic'))]
check('Elegir Claude usa Claude', len(cp._client.calls) == before + 1 and lines[-1]['type'] == 'done', lines[-1])
info = gmail.providers()
check('La lista de modelos ofrece Claude y Gemini, con el de fábrica', [o['id'] for o in info['options']] == ['anthropic', 'gemini'] and info['default'] == 'anthropic' and all(o['configured'] for o in info['options']), info)
check('El estado se puede pedir para el modelo elegido', gmail.health('gemini')['provider'] == 'Google Gemini' and gmail.health('anthropic')['provider'] == 'Anthropic Claude')
settings.GEMINI_API_KEY = type(settings.GEMINI_API_KEY)('')
lines = [json.loads(line) for line in gmail.stream_events(gmail.GmailChat(messages=[{'role': 'user', 'content': 'hola'}], tools=[], provider='gemini'))]
check('Elegir un modelo sin clave da un error claro', lines[0]['type'] == 'error' and 'no tiene clave' in lines[0]['detail'], lines)
check('…y la lista lo marca como no configurado', [o['configured'] for o in gmail.providers()['options']] == [True, False])
gmail.urlopen_with_retry, settings.GEMINI_API_KEY = original_open, original_key
settings.LLM_PROVIDER, settings.ANTHROPIC_API_KEY, cp._client = saved

print('\nHAY FALLOS (%d)' % fails if fails else '\nTODO OK')
sys.exit(1 if fails else 0)
