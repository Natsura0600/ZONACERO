# Zona Cero · Barbería

Sitio con turnos online, tarjeta de sellos y panel de administración.
No tiene dependencias ni build: Vercel lo publica tal cual.

- **Sitio:** `https://tu-proyecto.vercel.app/`
- **Panel:** `https://tu-proyecto.vercel.app/admin`

## Cómo subirlo a Vercel

1. **Subí el proyecto.** Usá una de estas dos opciones:
   - **GitHub:** creá un repositorio, subí el contenido de esta carpeta y en Vercel tocá *Add New → Project → Import*.
   - **Vercel CLI:** desde esta carpeta, corré `npx vercel --prod`.

   No cambies nada en la configuración: Vercel la detecta sola.

2. **Conectá la base de datos** (gratis):
   en el proyecto de Vercel, abrí **Storage → Create Database → Upstash for Redis**, elegí el plan gratis y conectalo al proyecto.
   Así se crean solas las variables `KV_REST_API_URL` y `KV_REST_API_TOKEN`.

3. **Hacé Redeploy:** en **Deployments**, abrí el menú `⋯` del último deploy y elegí **Redeploy**, para que tome la base de datos.

4. **Entrá a `/admin`.** La primera vez te pide crear tu contraseña.
   Hacelo apenas publiques el sitio: la primera persona que entre a `/admin` es la que elige la contraseña.
   Si preferís definirla de antemano, agregá la variable de entorno `ADMIN_PASSWORD` en Vercel antes del paso 3.

## Qué podés hacer desde el panel

| Pestaña | Para qué sirve |
|---|---|
| **Agenda** | Ver los turnos de cada día. Marcar “Atendido” (suma un sello), “No vino” o cancelar. Cargar turnos a mano, bloquear horarios y cerrar un día puntual. |
| **Clientes** | Ver los sellos de cada cliente, sumar o quitar sellos, canjear el premio, agregar notas y cargar clientes nuevos. |
| **Servicios** | Nombre, descripción y precio de cada servicio. Ordenarlos, ocultarlos o borrarlos. |
| **Horarios** | Días y horas en que se toman turnos (no se muestran en el sitio), duración de cada turno, feriados y barberos. |
| **Sitio** | Textos de la portada, aviso destacado, redes, reglas de la tarjeta de sellos, color principal y contraseña. |

## Cómo funciona la tarjeta de sellos

- Cada cliente se identifica por su celular.
- Cuando marcás un turno como **Atendido**, se suma un sello. Si vino sin turno, sumalo desde **Clientes → + Sello**.
- Al llegar a la meta (por defecto 10), aparece **Canjear premio**: al tocarlo se descuentan los sellos de la meta.
- El cliente ve sus sellos y sus próximos turnos en el sitio, en **Mi tarjeta**, poniendo su celular. Para cancelar un turno necesita el código que se le dio al reservar.

## Estructura

```
public/          sitio y panel (HTML, CSS, JS)
api/site.js      API pública: servicios, horarios libres, reservar, consultar tarjeta, cancelar
api/admin.js     API del panel (requiere sesión)
api/_lib/        base de datos, reglas de turnos y autenticación
```
