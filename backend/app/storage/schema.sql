-- NexoMail: migration 001. Execute with nexomail_app, not postgres.
CREATE TABLE IF NOT EXISTS nexomail.tbl_sis_migraciones (
    num_version integer PRIMARY KEY,
    fec_aplicacion timestamptz NOT NULL DEFAULT now(),
    est_registro char(1) NOT NULL DEFAULT 'A' CHECK (est_registro IN ('A','I','E'))
);

CREATE TABLE IF NOT EXISTS nexomail.tbl_mae_cuentas (
    id_cuenta uuid PRIMARY KEY,
    cod_proveedor varchar(20) NOT NULL CHECK (cod_proveedor IN ('gmail','microsoft')),
    cod_sujeto_proveedor varchar(128) NOT NULL,
    txt_correo varchar(255) NOT NULL,
    nom_usuario varchar(150) NOT NULL DEFAULT '',
    fec_ultimo_acceso timestamptz NOT NULL DEFAULT now(),
    est_registro char(1) NOT NULL DEFAULT 'A' CHECK (est_registro IN ('A','I','E')),
    fec_creacion timestamptz NOT NULL DEFAULT now(),
    fec_modificacion timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_cuenta_proveedor UNIQUE (cod_proveedor, cod_sujeto_proveedor)
);

CREATE TABLE IF NOT EXISTS nexomail.tbl_cfg_preferencias_usuario (
    id_cuenta uuid PRIMARY KEY REFERENCES nexomail.tbl_mae_cuentas(id_cuenta) ON DELETE CASCADE,
    cod_tema varchar(10) NOT NULL DEFAULT 'light' CHECK (cod_tema IN ('light','dark')),
    ind_modo_estricto boolean NOT NULL DEFAULT true,
    ind_ia_habilitada boolean NOT NULL DEFAULT true,
    ind_agrupacion_automatica boolean NOT NULL DEFAULT true,
    est_registro char(1) NOT NULL DEFAULT 'A' CHECK (est_registro IN ('A','I','E')),
    fec_creacion timestamptz NOT NULL DEFAULT now(),
    fec_modificacion timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nexomail.tbl_tra_mensajes_chat (
    id_mensaje varchar(64) NOT NULL,
    id_cuenta uuid NOT NULL REFERENCES nexomail.tbl_mae_cuentas(id_cuenta) ON DELETE CASCADE,
    cod_rol varchar(20) NOT NULL CHECK (cod_rol IN ('user','assistant')),
    txt_contenido text NOT NULL,
    num_posicion integer NOT NULL,
    est_registro char(1) NOT NULL DEFAULT 'A' CHECK (est_registro IN ('A','I','E')),
    fec_creacion timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id_cuenta, id_mensaje)
);

CREATE TABLE IF NOT EXISTS nexomail.tbl_tra_borradores (
    id_borrador varchar(64) NOT NULL,
    id_cuenta uuid NOT NULL REFERENCES nexomail.tbl_mae_cuentas(id_cuenta) ON DELETE CASCADE,
    txt_destinatario text NOT NULL DEFAULT '',
    txt_cc text NOT NULL DEFAULT '',
    txt_bcc text NOT NULL DEFAULT '',
    txt_asunto text NOT NULL DEFAULT '',
    txt_cuerpo text NOT NULL DEFAULT '',
    id_referencia_respuesta varchar(128),
    ind_adjuntos_omitidos boolean NOT NULL DEFAULT false,
    est_registro char(1) NOT NULL DEFAULT 'A' CHECK (est_registro IN ('A','I','E')),
    fec_creacion timestamptz NOT NULL,
    fec_modificacion timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id_cuenta, id_borrador)
);

CREATE TABLE IF NOT EXISTS nexomail.tbl_tra_versiones_espacio (
    id_cuenta uuid NOT NULL REFERENCES nexomail.tbl_mae_cuentas(id_cuenta) ON DELETE CASCADE,
    cod_seccion varchar(30) NOT NULL CHECK (cod_seccion IN ('chat','drafts','preferences')),
    num_revision integer NOT NULL DEFAULT 0 CHECK (num_revision >= 0),
    est_registro char(1) NOT NULL DEFAULT 'A' CHECK (est_registro IN ('A','I','E')),
    fec_modificacion timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id_cuenta, cod_seccion)
);

CREATE TABLE IF NOT EXISTS nexomail.tbl_aud_eventos (
    id_evento varchar(64) NOT NULL,
    id_cuenta uuid NOT NULL REFERENCES nexomail.tbl_mae_cuentas(id_cuenta) ON DELETE CASCADE,
    cod_tipo_accion varchar(50) NOT NULL,
    cod_estado_accion varchar(30) NOT NULL,
    des_evento text NOT NULL DEFAULT '',
    txt_detalles text NOT NULL DEFAULT '',
    fec_ocurrencia timestamptz NOT NULL,
    fec_registro timestamptz NOT NULL DEFAULT now(),
    cod_fuente varchar(30) NOT NULL DEFAULT 'extension_client',
    est_registro char(1) NOT NULL DEFAULT 'A' CHECK (est_registro IN ('A','I','E')),
    PRIMARY KEY (id_cuenta, id_evento)
);

CREATE INDEX IF NOT EXISTS idx_aud_cuenta_fecha ON nexomail.tbl_aud_eventos(id_cuenta, fec_ocurrencia DESC);
CREATE INDEX IF NOT EXISTS idx_chat_cuenta_pos ON nexomail.tbl_tra_mensajes_chat(id_cuenta, num_posicion ASC);
INSERT INTO nexomail.tbl_sis_migraciones(num_version, est_registro) VALUES(1, 'A') ON CONFLICT DO NOTHING;
