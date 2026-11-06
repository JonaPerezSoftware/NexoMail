"""All account identifiers come from a provider-verified access token, never a client email."""
from datetime import datetime, timezone
from typing import Literal, Any
import hashlib,json,time,uuid,threading
from urllib.request import Request,urlopen,HTTPRedirectHandler,build_opener
from urllib.error import HTTPError,URLError
from fastapi import APIRouter,Header,HTTPException
from pydantic import BaseModel,ConfigDict,Field,ValidationError
from app.storage.database import database

router=APIRouter(prefix='/storage',tags=['PostgreSQL'])
Provider=Literal['gmail','microsoft']
Section=Literal['chat','drafts','preferences']
_profiles:dict[tuple[str,str],tuple[float,dict]]={}
_profile_lock=threading.Lock()

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def identity(provider:Provider,authorization:str):
    if not authorization.startswith('Bearer ') or len(authorization)>16000:
        raise HTTPException(401,'Autoriza tu cuenta antes de utilizar el almacenamiento.')
    token=authorization[7:]
    if not token or any(c in token for c in '\r\n'):
        raise HTTPException(401,'La autorización de la cuenta no es válida.')
    key=(provider,hashlib.sha256(token.encode()).hexdigest())
    with _profile_lock:
        cached=_profiles.get(key)
        if cached and cached[0]>time.monotonic():return cached[1]
    url='https://gmail.googleapis.com/gmail/v1/users/me/profile' if provider=='gmail' else 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName'
    try:
        with build_opener(NoRedirect()).open(Request(url,headers={'Authorization':'Bearer '+token,'Accept':'application/json'}),timeout=10) as response:
            profile=json.loads(response.read(32000))
    except HTTPError as error:
        raise HTTPException(401 if error.code in (401,403) else 503,'No se pudo verificar la cuenta con el proveedor. Renueva la autorización o vuelve a intentarlo.') from None
    except (URLError,TimeoutError,ValueError):
        raise HTTPException(503,'El proveedor no respondió al verificar la cuenta. No se accedió a otros historiales.') from None
    email=(profile.get('emailAddress') if provider=='gmail' else profile.get('mail') or profile.get('userPrincipalName') or '').strip().lower()
    subject=email if provider=='gmail' else profile.get('id','')
    if not email or not subject or len(email)>320 or len(subject)>512:
        raise HTTPException(401,'El proveedor no devolvió una identidad de cuenta válida.')
    value={'provider':provider,'subject':subject,'email':email,'name':str(profile.get('displayName',''))[:300]}
    with _profile_lock:
        # Cache only fingerprints and public identity, not the bearer token.
        now=time.monotonic()
        for existing in list(_profiles):
            if _profiles[existing][0]<=now:_profiles.pop(existing,None)
        if len(_profiles)>=256:_profiles.clear()
        _profiles[key]=(now+45,value)
    return value

class Strict(BaseModel):
    model_config=ConfigDict(extra='forbid')
class ChatRecord(Strict):
    id:str=Field(min_length=1,max_length=150)
    role:Literal['user','assistant']
    content:str=Field(max_length=20000)
    created_at:datetime
class DraftRecord(Strict):
    id:str=Field(min_length=1,max_length=150)
    to:str=Field(default='',max_length=2000)
    cc:str=Field(default='',max_length=2000)
    bcc:str=Field(default='',max_length=2000)
    subject:str=Field(default='',max_length=998)
    body:str=Field(default='',max_length=30000)
    reply_to_id:str|None=Field(default=None,max_length=1024)
    attachments_omitted:bool=False
    created_at:datetime
class Preferences(Strict):
    theme:Literal['light','dark']='light'
    strict_mode:bool=True
    llm_enabled:bool=True
    auto_grouping:bool=True
class WriteSection(Strict):
    revision:int=Field(ge=0,le=2147483646)
    data:Any
class AuditRecord(Strict):
    id:str=Field(min_length=1,max_length=150)
    action_type:str=Field(min_length=1,max_length=80)
    status:str=Field(min_length=1,max_length=80)
    description:str=Field(default='',max_length=2000)
    details:str=Field(default='',max_length=4000)
    occurred_at:datetime
class AuditBatch(Strict):
    events:list[AuditRecord]=Field(max_length=100)
class ProposalRecord(Strict):
    id:str=Field(min_length=1,max_length=150)
    action_type:Literal['SEND_EMAIL','DELETE_EMAIL','BULK_CLEANUP','LABEL_EMAIL','RESTORE_EMAIL','MARK_READ','DRAFT_REPLY']
    # The whole proposal as the extension shows it, without attachment contents.
    proposal:dict[str,Any]
    created_at:datetime
class ProposalBatch(Strict):
    proposals:list[ProposalRecord]=Field(max_length=50)
MAX_PROPOSAL_BYTES=60000

def account(connection,profile):
    return connection.execute('''INSERT INTO nexomail.tbl_mae_cuentas(id_cuenta,cod_proveedor,cod_sujeto_proveedor,txt_correo,nom_usuario,est_registro,fec_creacion,fec_modificacion,fec_ultimo_acceso)
        VALUES(%s,%s,%s,%s,%s,'A',now(),now(),now()) ON CONFLICT(cod_proveedor,cod_sujeto_proveedor) DO UPDATE
        SET txt_correo=excluded.txt_correo,nom_usuario=excluded.nom_usuario,fec_ultimo_acceso=now(),fec_modificacion=now(),est_registro='A' RETURNING id_cuenta''',
        (uuid.uuid4(),profile['provider'],profile['subject'],profile['email'],profile['name'])).fetchone()['id_cuenta']

def utc(value:datetime):
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

@router.get('/{provider}/workspace')
def load_workspace(provider:Provider,authorization:str=Header(default='')):
    profile=identity(provider,authorization)
    with database() as connection:
        aid=account(connection,profile)
        versions={row['cod_seccion']:row['num_revision'] for row in connection.execute('SELECT cod_seccion,num_revision FROM nexomail.tbl_tra_versiones_espacio WHERE id_cuenta=%s AND est_registro!=%s',(aid,'E'))}
        chat=[{'id':row['id_mensaje'],'role':row['cod_rol'],'content':row['txt_contenido'],'created_at':row['fec_creacion']} for row in connection.execute('SELECT id_mensaje,cod_rol,txt_contenido,fec_creacion FROM nexomail.tbl_tra_mensajes_chat WHERE id_cuenta=%s AND est_registro!=%s ORDER BY num_posicion',(aid,'E'))]
        drafts=[{'id':row['id_borrador'],'to':row['txt_destinatario'],'cc':row['txt_cc'],'bcc':row['txt_bcc'],'subject':row['txt_asunto'],'body':row['txt_cuerpo'],'reply_to_id':row['id_referencia_respuesta'],'attachments_omitted':row['ind_adjuntos_omitidos'],'created_at':row['fec_creacion']} for row in connection.execute('SELECT id_borrador,txt_destinatario,txt_cc,txt_bcc,txt_asunto,txt_cuerpo,id_referencia_respuesta,ind_adjuntos_omitidos,fec_creacion FROM nexomail.tbl_tra_borradores WHERE id_cuenta=%s AND est_registro!=%s ORDER BY fec_modificacion DESC',(aid,'E'))]
        pref_row=connection.execute('SELECT cod_tema,ind_modo_estricto,ind_ia_habilitada,ind_agrupacion_automatica FROM nexomail.tbl_cfg_preferencias_usuario WHERE id_cuenta=%s AND est_registro!=%s',(aid,'E')).fetchone()
        preferences={'theme':pref_row['cod_tema'],'strict_mode':pref_row['ind_modo_estricto'],'llm_enabled':pref_row['ind_ia_habilitada'],'auto_grouping':pref_row['ind_agrupacion_automatica']} if pref_row else None
        audits=[{'id':row['id_evento'],'action_type':row['cod_tipo_accion'],'status':row['cod_estado_accion'],'description':row['des_evento'],'details':row['txt_detalles'],'occurred_at':row['fec_ocurrencia']} for row in connection.execute('SELECT id_evento,cod_tipo_accion,cod_estado_accion,des_evento,txt_detalles,fec_ocurrencia FROM nexomail.tbl_aud_eventos WHERE id_cuenta=%s AND est_registro!=%s ORDER BY fec_ocurrencia DESC LIMIT 500',(aid,'E'))]
        return {'account':{'provider':provider,'email':profile['email']},'sections':{
            name:{'revision':versions.get(name,0),'data':data} for name,data in [('chat',chat),('drafts',drafts),('preferences',preferences)]},'audit':audits}

@router.post('/{provider}/workspace/{section}')
def write_section(provider:Provider,section:Section,body:WriteSection,authorization:str=Header(default='')):
    try:
        if section=='preferences':data=Preferences.model_validate(body.data)
        else:
            if not isinstance(body.data,list) or len(body.data)>(100 if section=='chat' else 50):raise ValueError()
            model=ChatRecord if section=='chat' else DraftRecord
            data=[model.model_validate(item) for item in body.data]
            if len({item.id for item in data})!=len(data):raise ValueError()
    except (ValueError,ValidationError):
        raise HTTPException(422,'El contenido del historial o borrador no tiene un formato válido o supera el límite.') from None
    profile=identity(provider,authorization)
    with database() as connection:
        aid=account(connection,profile)
        connection.execute('INSERT INTO nexomail.tbl_tra_versiones_espacio(id_cuenta,cod_seccion,num_revision,est_registro,fec_modificacion) VALUES(%s,%s,0,%s,now()) ON CONFLICT DO NOTHING',(aid,section,'A'))
        revision=connection.execute('SELECT num_revision FROM nexomail.tbl_tra_versiones_espacio WHERE id_cuenta=%s AND cod_seccion=%s FOR UPDATE',(aid,section)).fetchone()['num_revision']
        if revision!=body.revision:
            raise HTTPException(409,'Otra ventana cambió estos datos. Recarga NexoMail para recuperar la versión guardada; no se sobrescribieron los cambios.')
        if section=='chat':
            connection.execute('DELETE FROM nexomail.tbl_tra_mensajes_chat WHERE id_cuenta=%s',(aid,))
            for position,item in enumerate(data):
                connection.execute('INSERT INTO nexomail.tbl_tra_mensajes_chat(id_cuenta,id_mensaje,cod_rol,txt_contenido,num_posicion,est_registro,fec_creacion) VALUES(%s,%s,%s,%s,%s,%s,%s)',(aid,item.id,item.role,item.content,position,'A',utc(item.created_at)))
        elif section=='drafts':
            connection.execute('DELETE FROM nexomail.tbl_tra_borradores WHERE id_cuenta=%s',(aid,))
            for item in data:
                connection.execute('INSERT INTO nexomail.tbl_tra_borradores(id_cuenta,id_borrador,txt_destinatario,txt_cc,txt_bcc,txt_asunto,txt_cuerpo,id_referencia_respuesta,ind_adjuntos_omitidos,est_registro,fec_creacion,fec_modificacion) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())',(aid,item.id,item.to,item.cc,item.bcc,item.subject,item.body,item.reply_to_id,item.attachments_omitted,'A',utc(item.created_at)))
        else:
            connection.execute('''INSERT INTO nexomail.tbl_cfg_preferencias_usuario(id_cuenta,cod_tema,ind_modo_estricto,ind_ia_habilitada,ind_agrupacion_automatica,est_registro,fec_creacion,fec_modificacion) VALUES(%s,%s,%s,%s,%s,%s,now(),now())
                ON CONFLICT(id_cuenta) DO UPDATE SET cod_tema=excluded.cod_tema,ind_modo_estricto=excluded.ind_modo_estricto,ind_ia_habilitada=excluded.ind_ia_habilitada,ind_agrupacion_automatica=excluded.ind_agrupacion_automatica,fec_modificacion=now()''',(aid,data.theme,data.strict_mode,data.llm_enabled,data.auto_grouping,'A'))
        connection.execute('UPDATE nexomail.tbl_tra_versiones_espacio SET num_revision=num_revision+1,fec_modificacion=now() WHERE id_cuenta=%s AND cod_seccion=%s',(aid,section))
        return {'revision':revision+1,'saved':True}

@router.post('/{provider}/audit')
def append_audit(provider:Provider,body:AuditBatch,authorization:str=Header(default='')):
    profile=identity(provider,authorization)
    with database() as connection:
        aid=account(connection,profile)
        for event in body.events:
            connection.execute('''INSERT INTO nexomail.tbl_aud_eventos(id_cuenta,id_evento,cod_tipo_accion,cod_estado_accion,des_evento,txt_detalles,fec_ocurrencia,fec_registro,cod_fuente,est_registro)
                VALUES(%s,%s,%s,%s,%s,%s,%s,now(),%s,%s) ON CONFLICT DO NOTHING''',(aid,event.id,event.action_type,event.status,event.description,event.details,utc(event.occurred_at),'extension_client','A'))
    return {'saved':True}

@router.get('/{provider}/proposals')
def load_proposals(provider:Provider,authorization:str=Header(default='')):
    profile=identity(provider,authorization)
    with database() as connection:
        aid=account(connection,profile)
        rows=connection.execute('SELECT id_propuesta,cod_tipo_accion,txt_propuesta,fec_creacion FROM nexomail.tbl_tra_propuestas WHERE id_cuenta=%s AND est_registro!=%s ORDER BY num_posicion',(aid,'E'))
        return {'proposals':[{'id':row['id_propuesta'],'action_type':row['cod_tipo_accion'],'proposal':row['txt_propuesta'],'created_at':row['fec_creacion']} for row in rows]}

@router.post('/{provider}/proposals')
def save_proposals(provider:Provider,body:ProposalBatch,authorization:str=Header(default='')):
    """Replaces the account's pending proposals with the list the extension shows."""
    if len({item.id for item in body.proposals})!=len(body.proposals) or any(len(json.dumps(item.proposal,ensure_ascii=False))>MAX_PROPOSAL_BYTES for item in body.proposals):
        raise HTTPException(422,'Las propuestas no tienen un formato válido o superan el límite.')
    profile=identity(provider,authorization)
    with database() as connection:
        aid=account(connection,profile)
        connection.execute('DELETE FROM nexomail.tbl_tra_propuestas WHERE id_cuenta=%s',(aid,))
        for position,item in enumerate(body.proposals):
            connection.execute('INSERT INTO nexomail.tbl_tra_propuestas(id_cuenta,id_propuesta,cod_tipo_accion,txt_propuesta,num_posicion,est_registro,fec_creacion,fec_modificacion) VALUES(%s,%s,%s,%s::jsonb,%s,%s,%s,now())',
                (aid,item.id,item.action_type,json.dumps(item.proposal,ensure_ascii=False),position,'A',utc(item.created_at)))
    return {'saved':True}

@router.post('/{provider}/erase')
def erase_workspace(provider:Provider,authorization:str=Header(default='')):
    profile=identity(provider,authorization)
    with database() as connection:
        # An exclusive account lock prevents a concurrent save interleaving with deletion.
        aid=account(connection,profile)
        connection.execute('DELETE FROM nexomail.tbl_tra_mensajes_chat WHERE id_cuenta=%s',(aid,))
        connection.execute('DELETE FROM nexomail.tbl_tra_borradores WHERE id_cuenta=%s',(aid,))
        connection.execute('DELETE FROM nexomail.tbl_cfg_preferencias_usuario WHERE id_cuenta=%s',(aid,))
        connection.execute('DELETE FROM nexomail.tbl_tra_propuestas WHERE id_cuenta=%s',(aid,))
        connection.execute('DELETE FROM nexomail.tbl_aud_eventos WHERE id_cuenta=%s',(aid,))
        for section in ('chat','drafts','preferences'):
            connection.execute('''INSERT INTO nexomail.tbl_tra_versiones_espacio(id_cuenta,cod_seccion,num_revision,est_registro,fec_modificacion) VALUES(%s,%s,1,%s,now())
                ON CONFLICT(id_cuenta,cod_seccion) DO UPDATE SET num_revision=nexomail.tbl_tra_versiones_espacio.num_revision+1,fec_modificacion=now()''',(aid,section,'A'))
    return {'erased':True}
