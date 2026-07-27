# Hoja de ruta

Lo pendiente, ordenado por lo que más mejora **Cincel**, el motor de trazado.
Cada punto lleva por qué importa y cómo se comprueba que funcionó.

El criterio de siempre: nada se da por bueno sin medirlo, y nada se mide sin
mirarlo también. Las dos veces que la métrica apuntó al lado contrario se
detectaron mirando el resultado, no leyendo números.

## Motor

### 1. Tintas que comparten borde

**Estado:** conocido y sin resolver. Es el hueco más claro que queda.

Hoy cada tinta se traza por separado y se emite como una capa propia. Funciona
mientras las tintas no se toquen, que es el caso de todos los logos probados
hasta ahora. Cuando dos colores comparten borde, cada capa calcula su contorno
sin saber de la otra: en la costura quedan huecos por donde se ve el fondo, o
solapes que oscurecen la línea de unión.

Hace falta una topología común — que el borde entre dos tintas sea **una sola
curva** compartida por ambas, no dos curvas calculadas por separado.

**Caso de prueba:** la placa cuadrada verde con la hoja blanca del propio logo
de Vectoria.

**Cómo se comprueba:** rasterizar el SVG resultante y buscar píxeles de fondo
dentro de la silueta combinada. Ahora mismo aparecerían; después, ninguno.

### 2. Simetría

Muchos logos son simétricos respecto a un eje, y ahora cada mitad se traza por
su cuenta con su propio temblor. El ojo detecta la asimetría al instante aunque
sea de una décima de píxel.

Detectar el eje y promediar las dos mitades es geometría barata. El riesgo es
forzar simetría donde no la hay, así que sólo debe aplicarse cuando la
coincidencia entre mitades esté por debajo de un umbral claro.

**Cómo se comprueba:** distancia entre una mitad y el reflejo de la otra, antes
y después. Y que una forma deliberadamente asimétrica no se toque.

### 3. Arcos parciales

Cincel reconoce círculos y elipses **completos** y los emite como forma exacta,
pero no reconoce un arco dentro de un contorno. Los vértices redondeados del
propio símbolo de Vectoria son arcos de radio constante y salen como cúbicas
ajustadas.

Emitirlos como arcos daría menos nodos y precisión exacta, y encaja con la
detección de tramos rectos ya existente: recta, arco, recta, arco es justo la
descripción de un rectángulo redondeado.

**Cómo se comprueba:** número de nodos y error de área sobre el rectángulo
redondeado del banco de pruebas, más el símbolo real.

### 4. Suelo de ruido de la extracción

El contorno crudo que sale de marching squares se desvía unos **0,037 px de
media** del borde real en un archivo limpio. Ese es el suelo actual: por debajo
de ahí, apretar la tolerancia sólo persigue ruido.

Para bajarlo hay que estimar la posición del borde a partir de la cobertura de
la vecindad 3×3 en vez de interpolar linealmente entre dos píxeles. Para un
borde recto el cálculo es exacto. Estimación: de 0,037 a ~0,01 px, y como efecto
secundario el perfil Preciso daría **menos** nodos, no más, porque dejaría de
perseguir ruido.

Es la única vía que queda para ganar precisión real; todo lo demás ya topa
contra este límite.

**Cómo se comprueba:** desviación media del contorno crudo frente a formas
sintéticas con antialias exacto, que ya están en el banco.

### 5. JPEG

Nunca se ha probado. Todos los archivos usados han sido PNG.

Un JPEG mete anillos alrededor de los bordes que contaminan el campo de
cobertura **antes** de que la sonda de ruido lo mire, así que el autocalibrado
podría estar midiendo el artefacto en lugar de la calidad real del borde. Es un
formato muy común y es un hueco de cobertura, no una mejora.

**Cómo se comprueba:** el mismo logo guardado en PNG y en JPEG a varias
calidades; comparar ruido medido, nodos y error de área.

## Infraestructura

### 6. El lote de logos como script del repositorio

Durante todo el desarrollo, el lote de siete logos reales se ha ejecutado a mano
desde una carpeta temporal. Debería vivir en `scripts/` y correr con un comando,
midiendo error de área, nodos, esquinas y tiempo de cada archivo.

No mejora el motor por sí mismo, pero hace que cualquier cambio futuro se mida
solo contra archivos reales. Dado que la fidelidad al ráster ya apuntó dos veces
en la dirección equivocada, tener el lote automatizado vale más de lo que parece.

Los logos no van al repositorio si son de clientes; el script debe apuntar a una
carpeta configurable.

## Descartado por ahora

- **Red neuronal.** Es lo que permite a los servicios comerciales reconstruir
  detalle que el ráster ya no contiene. Los datos de entrenamiento serían fáciles
  de generar —rasterizar SVG y fuentes con degradaciones controladas da pares
  perfectos—, pero entrenar bien y servir el modelo es un proyecto aparte, y
  chocaría con que todo el procesamiento sea local.
- **Issues de GitHub.** El repositorio es privado y la licencia no admite
  contribuciones ni forks, así que no hay nadie con quien coordinarse. Este
  archivo cumple la función. Cambiaría si el proyecto se abre al público.
