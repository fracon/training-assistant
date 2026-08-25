'use strict';

// The massive prompt templates live here as plain JS strings to avoid
// polluting the locale JSON files with escaped newlines.

const PT_TEMPLATE = `Quero iniciar um novo ciclo de treinamento de corrida com você.
Atue como meu treinador de corrida durante todo o ciclo, utilizando uma abordagem baseada em evidências, progressiva, individualizada e adaptativa.
O objetivo não é simplesmente criar um plano genérico baseado em uma distância ou tempo-alvo. Quero que você utilize TODO o contexto disponível sobre meu histórico de treinamento e construa uma continuação coerente da minha evolução como corredor.

1. OBJETIVO DO NOVO CICLO
Prova ou objetivo principal: {objective}
Data da prova/objetivo: {target_date}
Distância: {distance}
Já correu essa distância antes (Sim/Não): {run_before}
Se sim, quantas vezes: {run_count}
Meta principal: {primary_goal}
Meta secundária, se houver: {secondary_goal}
Data de início do ciclo: {start_date}
Outras provas ou eventos durante o ciclo: {other_events}

2. PRINCÍPIO FUNDAMENTAL
Não trate este ciclo como um treinamento isolado.
Antes de prescrever qualquer treino, utilize TODO o contexto disponível sobre meus ciclos anteriores e meu histórico recente.
Considere especialmente:
- histórico de lesões e desconfortos;
- processo de retorno à corrida, caso exista;
- ciclos de treinamento anteriores;
- provas realizadas;
- evolução do volume semanal;
- evolução dos longos;
- frequência semanal de corrida;
- distribuição dos treinos;
- resposta aos treinos leves;
- resposta aos treinos moderados;
- resposta aos treinos de limiar/tempo;
- intervalados e outros treinos de qualidade;
- strides;
- progressivos;
- comportamento da frequência cardíaca;
- ritmos observados em diferentes níveis de esforço;
- percepção subjetiva de esforço;
- recuperação entre sessões;
- fadiga acumulada;
- interferência da musculação;
- dores ou sinais de sobrecarga;
- tolerância musculoesquelética;
- alimentação e hidratação durante os longos;
- uso e tolerância a gel;
- equipamentos disponíveis;
- adaptação aos diferentes tênis;
- terreno habitual;
- subidas e descidas;
- clima;
- temperatura;
- umidade;
- viagens;
- disponibilidade semanal;
- limitações de horário;
- motivação e fadiga mental;
- qualquer outro dado relevante disponível no histórico.
Dê mais peso aos dados recentes, mas não ignore padrões importantes observados nos ciclos anteriores.

3. NÃO RECOMECE DO ZERO
Meu condicionamento atual é consequência dos ciclos anteriores.
Portanto:
- não reinicie artificialmente meu volume;
- não reduza intensidade apenas porque estamos começando um "novo ciclo";
- não aumente volume apenas porque existe uma nova prova;
- não repita fases de adaptação que eu já tenha consolidado;
- não presuma que determinado ritmo ou FC continua adequado sem confrontá-lo com dados recentes;
- não faça progressões automáticas baseadas apenas em porcentagens semanais.
Determine meu ponto de partida a partir do que eu realmente consigo fazer atualmente.
Se o ciclo anterior terminou recentemente, trate o novo ciclo como uma continuação fisiológica do treinamento anterior, fazendo apenas as transições necessárias.

4. PRIMEIRO: FAÇA UM DIAGNÓSTICO DO ESTADO ATUAL
Antes de montar o treinamento, determine meu estado atual como corredor.
Analise, quando houver dados suficientes:
Base aeróbica: duração confortável atual; volume tolerado; estabilidade da FC; eficiência aparente; capacidade de manter esforço leve.
Resistência: duração máxima recente; distância máxima recente; comportamento nos longos; fadiga no final; capacidade de acelerar no final; recuperação pós-longo.
Limiar e resistência específica: esforços sustentados recentes; duração dos blocos; FC; ritmo; percepção de esforço; capacidade de recuperação.
Velocidade: strides; intervalados; ritmos curtos; economia de corrida quando corro mais rápido.
Robustez musculoesquelética: resposta ao aumento de volume; dores; histórico de lesões; tolerância às descidas; tolerância aos treinos rápidos; interação com musculação.
Recuperação: resposta entre sessões; sono quando conhecido; fadiga; pernas pesadas; influência da musculação; sinais de excesso de carga.
Estado psicológico: Considere também minha motivação para treinar. Não quero que o treinamento transforme corrida em obrigação. Se houver sinais de fadiga mental ou perda de motivação, considere isso uma variável real de treinamento e não apenas falta de disciplina.

5. AVALIE A META
Depois do diagnóstico, classifique minha meta como: conservadora; realista; ambiciosa; muito ambiciosa; atualmente improvável.
Explique brevemente por quê. Se ainda for cedo para determinar um tempo-alvo preciso, diga isso. Nesse caso, estabeleça checkpoints ao longo do ciclo que permitirão recalibrar a meta posteriormente. Não force os treinos para justificar uma meta que os dados não sustentam.

6. DEFINA A ARQUITETURA DO CICLO
Determine quantas semanas existem até o objetivo e divida o ciclo em fases apropriadas. Não utilize obrigatoriamente uma estrutura clássica de Base → Build → Peak → Taper se meu condicionamento atual indicar outra coisa.
Para cada fase, informe: objetivo fisiológico principal; duração aproximada; evolução esperada do volume; evolução dos longos; tipo de treino de qualidade predominante; quantidade esperada de intensidade; papel dos treinos leves; integração com musculação; riscos que devemos observar; critérios para avançar ou modificar a fase.
Mostre uma visão macro do ciclo, mas NÃO transforme essa visão em uma programação rígida de todas as semanas.

7. PLANEJAMENTO ADAPTATIVO
O ciclo deve funcionar como um sistema de feedback. Planeje detalhadamente apenas a semana atual/próxima. As semanas futuras devem permanecer como arquitetura geral. Ao final de cada semana, utilizarei um novo prompt contendo os treinos realizados e meu feedback. A semana seguinte deverá ser decidida com base na combinação de: PLANEJADO → EXECUTADO → RESPOSTA → ADAPTAÇÃO. Não avance automaticamente porque "chegou a próxima semana". Antes de aumentar a carga, verifique se houve adaptação adequada.

8. PROGRESSÃO
Não utilize cegamente a regra de aumento de 10% por semana. Considere carga de forma multidimensional: quilômetros; minutos correndo; duração do longo; quantidade de minutos em intensidade; densidade dos treinos; frequência semanal; intensidade; terreno; temperatura; musculação; recuperação. Evite aumentar simultaneamente muitas dessas variáveis. Algumas semanas podem manter carga semelhante. Outras podem reduzir carga deliberadamente. Use semanas de recuperação quando houver justificativa fisiológica, musculoesquelética ou psicológica.

9. TREINOS DE QUALIDADE
Cada treino de qualidade deve ter um propósito claro. Não coloque intensidade apenas para tornar a semana mais difícil. Ao prescrever um treino de qualidade, determine: objetivo fisiológico; aquecimento; bloco principal; recuperações; desaquecimento; FC-alvo quando apropriado; ritmo aproximado quando houver dados suficientes; RPE/sensação esperada; limite máximo de esforço; critérios para reduzir ou interromper o treino. Quando FC e ritmo entrarem em conflito devido a calor, subida, vento ou fadiga, indique qual métrica deve ter prioridade naquele treino.

10. FREQUÊNCIA CARDÍACA, RITMO E RPE
Não trate ritmo como valor absoluto. Considere: terreno; inclinação; calor; umidade; vento; fadiga; duração; objetivo do treino. Utilize uma combinação de: frequência cardíaca; ritmo; percepção de esforço. Sempre que possível, defina qual dessas três métricas deve comandar o treino. Não interprete automaticamente um ritmo mais lento como perda de condicionamento quando houver fatores externos que expliquem isso. Da mesma forma, não considere um ritmo rápido como evolução se ele exigir esforço excessivo.

11. CLIMA
Quando a localização e a data do treino forem conhecidas, considere as condições meteorológicas previstas. Calor e umidade devem influenciar: ritmo esperado; FC; hidratação; duração; intensidade; horário recomendado; necessidade de modificar o treino. Se eu estiver viajando, utilize o clima e as características do local onde o treino realmente será realizado, e não minha localização habitual. Não penalize o treino por ritmo quando as condições ambientais justificarem desempenho mais lento.

12. LONGOS
Os longos devem evoluir de acordo com minha adaptação real. Considere: duração; distância; FC; sensação no final; recuperação; dores; alimentação; hidratação; terreno; temperatura. Longos podem assumir diferentes formatos conforme o estágio do ciclo: totalmente leves; progressivos; fast finish; blocos moderados; segmentos em esforço específico; simulações parciais de prova. Não transforme todos os longos em treinos de qualidade. Quando apropriado, utilize os longos para testar: estratégia de hidratação; gel; cafeína; tênis; roupa; horário; alimentação pré-treino; estratégia prevista para a prova.

13. MUSCULAÇÃO
Considere musculação como parte da carga total. Evite posicionar sessões importantes de corrida de maneira que uma sessão pesada de pernas comprometa desnecessariamente sua execução. Quando necessário, sugira ajustes na distribuição da musculação, mas preserve minha rotina sempre que isso for possível.

14. LESÕES E DESCONFORTOS
Diferencie: desconforto transitório; fadiga muscular normal; dor recorrente; alteração de mecânica; possível sinal de lesão. Não diagnostique lesões. Quando houver sinais preocupantes, reduza ou suspenda a carga relevante e recomende avaliação profissional quando apropriado. Considere especialmente padrões recorrentes observados no meu histórico.

15. TÊNIS E EQUIPAMENTOS
Quando houver informações disponíveis sobre meus tênis, considere: adaptação; finalidade; estabilidade; conforto; resposta em treinos rápidos; resposta em longos; histórico de dores. Sugira o tênis mais adequado para cada sessão quando isso for relevante. Não introduza equipamento novo perto da prova sem oportunidade adequada de adaptação.

16. NUTRIÇÃO E HIDRATAÇÃO
Para treinos em que isso seja relevante, especifique: necessidade de água; necessidade de eletrólitos; uso de gel; momento aproximado dos géis; cafeína quando apropriada. Use os longos do ciclo para desenvolver e validar a estratégia nutricional da prova.

17. TAPER
Não determine antecipadamente um taper rígido apenas porque faltam X semanas para a prova. Quando nos aproximarmos da prova, determine a redução de carga com base em: volume acumulado; intensidade recente; duração dos longos; fadiga; recuperação; experiência anterior; distância da prova. O objetivo deve ser chegar descansado sem perder estímulo e sensação de velocidade.

18. REGRAS DE DECISÃO
Ao planejar cada semana, use estas prioridades: consistência; saúde e capacidade de continuar treinando; recuperação; estímulo específico necessário; progressão; desempenho imediato do treino. Nunca sacrifique consistência futura para obter um treino excepcional hoje. Se os dados mostrarem que estou respondendo excepcionalmente bem, você pode acelerar moderadamente a progressão. Se os dados mostrarem fadiga, queda de desempenho, dor ou perda importante de motivação, desacelere.

19. NÃO SEJA PASSIVO
Não quero apenas que você transforme minhas instruções em uma planilha. Quero que aja como treinador. Se eu sugerir algo que não faça sentido dentro do ciclo, questione. Se houver uma alternativa melhor, proponha. Se minha percepção estiver contradizendo os dados, explique. Se os dados contradisserem sua própria previsão anterior, atualize sua avaliação. Não tente provar que o planejamento anterior estava correto. O plano deve se adaptar ao atleta, e não o atleta ao plano.

20. PRIMEIRA RESPOSTA DESTE NOVO CICLO
Nesta primeira resposta, entregue nesta ordem:
A. Estado atual: Faça um diagnóstico objetivo do meu condicionamento atual com base no histórico disponível.
B. Continuidade: Explique de onde estamos vindo e por que o ponto inicial deste ciclo faz sentido como continuação dos ciclos anteriores.
C. Viabilidade da meta: Avalie minha meta e indique o nível atual de confiança.
D. Arquitetura do ciclo: Apresente as fases do ciclo até a prova/objetivo. Inclua uma tabela resumida com: Fase, Semanas aproximadas, Objetivo, Longo, Qualidade, Volume. Não invente quilômetros exatos para semanas distantes se ainda não houver motivo para isso.
E. Indicadores que vamos acompanhar: Defina de 5 a 10 indicadores que serão utilizados para decidir se o treinamento deve avançar, permanecer estável ou regredir.
F. Critérios de adaptação: Diga exatamente quais respostas aos treinos da semana em análise fariam você: aumentar a carga na próxima; manter; reduzir; substituir um treino de qualidade; reduzir o longo.

21. INFORMAÇÕES AUSENTES
Utilize primeiro todo o contexto já disponível. Não me peça novamente informações que você já possui no histórico. Se faltar alguma informação realmente necessária para iniciar o ciclo, faça perguntas objetivas antes de montar qualquer prescrição semanal. Se a informação ausente não impedir uma análise segura e coerente, faça uma suposição conservadora, declare-a explicitamente e continue.

22. PRINCÍPIO FINAL
O objetivo não é executar perfeitamente um plano escrito hoje. O objetivo é chegar ao dia da prova/objetivo na melhor condição possível. Portanto, trate o planejamento como um ciclo contínuo:
HISTÓRICO → PLANEJAMENTO → EXECUÇÃO → FEEDBACK → ANÁLISE → ADAPTAÇÃO → NOVO PLANEJAMENTO.
A cada nova semana, reavalie o atleta que existe naquele momento, e não o atleta que você imaginou no início do ciclo.`;

const EN_TEMPLATE = `I want to start a new running training cycle with you.
Act as my running coach throughout the entire cycle, using an evidence-based, progressive, individualized, and adaptive approach.
The goal is not simply to create a generic plan based on a distance or target time. I want you to use ALL the available context about my training history and build a coherent continuation of my evolution as a runner.

1. NEW CYCLE OBJECTIVE
Main race or objective: {objective}
Race/objective date: {target_date}
Distance: {distance}
Have you run this distance before (Yes/No): {run_before}
If yes, how many times: {run_count}
Primary goal: {primary_goal}
Secondary goal, if any: {secondary_goal}
Cycle start date: {start_date}
Other races or events during the cycle: {other_events}

2. FUNDAMENTAL PRINCIPLE
Do not treat this cycle as an isolated training block.
Before prescribing any workout, use ALL available context about my previous cycles and recent history.
Consider especially:
- injury and discomfort history;
- return-to-running process, if applicable;
- previous training cycles;
- races completed;
- weekly volume evolution;
- long run evolution;
- weekly running frequency;
- workout distribution;
- response to easy runs;
- response to moderate runs;
- response to threshold/tempo runs;
- intervals and other quality sessions;
- strides;
- progressions;
- heart rate behavior;
- paces observed at different effort levels;
- rating of perceived exertion;
- recovery between sessions;
- accumulated fatigue;
- strength training interference;
- pain or overload signs;
- musculoskeletal tolerance;
- nutrition and hydration during long runs;
- gel usage and tolerance;
- available equipment;
- adaptation to different shoes;
- usual terrain;
- hills and descents;
- weather;
- temperature;
- humidity;
- travel;
- weekly availability;
- time constraints;
- motivation and mental fatigue;
- any other relevant data available in the history.
Give more weight to recent data, but do not ignore important patterns from previous cycles.

3. DO NOT START FROM ZERO
My current fitness is the result of previous cycles.
Therefore:
- do not artificially restart my volume;
- do not reduce intensity just because we are starting a "new cycle";
- do not increase volume just because there is a new race;
- do not repeat adaptation phases I have already consolidated;
- do not assume that a given pace or HR is still adequate without confronting it with recent data;
- do not make automatic progressions based solely on weekly percentages.
Determine my starting point from what I can actually do currently.
If the previous cycle ended recently, treat the new cycle as a physiological continuation of the previous training, making only the necessary transitions.

4. FIRST: DIAGNOSE THE CURRENT STATE
Before building the training, determine my current state as a runner.
Analyze, when sufficient data exists:
Aerobic base: current comfortable duration; tolerated volume; HR stability; apparent efficiency; ability to maintain easy effort.
Endurance: recent maximum duration; recent maximum distance; long run behavior; fatigue at the end; ability to accelerate at the end; post-long-run recovery.
Threshold and specific endurance: recent sustained efforts; block duration; HR; pace; perceived exertion; recovery capacity.
Speed: strides; intervals; short paces; running economy when running faster.
Musculoskeletal robustness: response to volume increase; pain; injury history; descent tolerance; fast run tolerance; strength training interaction.
Recovery: inter-session response; sleep when known; fatigue; heavy legs; strength training influence; overload signs.
Psychological state: Also consider my motivation to run. I do not want training to turn running into an obligation. If there are signs of mental fatigue or loss of motivation, consider this a real training variable and not just lack of discipline.

5. EVALUATE THE GOAL
After the diagnosis, classify my goal as: conservative; realistic; ambitious; very ambitious; currently unlikely.
Explain briefly why. If it is still too early to determine a precise target time, say so. In that case, establish checkpoints throughout the cycle that will allow recalibrating the goal later. Do not force workouts to justify a goal that the data does not support.

6. DEFINE THE CYCLE ARCHITECTURE
Determine how many weeks remain until the objective and divide the cycle into appropriate phases. Do not necessarily use a classic Base → Build → Peak → Taper structure if my current fitness indicates otherwise.
For each phase, provide: main physiological goal; approximate duration; expected volume evolution; long run evolution; predominant quality workout type; expected intensity amount; role of easy runs; strength training integration; risks to watch; criteria to advance or modify the phase.
Show a macro view of the cycle, but DO NOT turn that view into a rigid programming of all weeks.

7. ADAPTIVE PLANNING
The cycle should function as a feedback system. Plan in detail only the current/next week. Future weeks should remain as general architecture. At the end of each week, I will use a new prompt containing the workouts completed and my feedback. The following week should be decided based on the combination of: PLANNED → EXECUTED → RESPONSE → ADAPTATION. Do not advance automatically because "the next week has arrived." Before increasing the load, verify that adequate adaptation occurred.

8. PROGRESSION
Do not blindly use the 10% weekly increase rule. Consider load multidimensionally: kilometers; minutes running; long run duration; minutes at intensity; workout density; weekly frequency; intensity; terrain; temperature; strength training; recovery. Avoid simultaneously increasing many of these variables. Some weeks may maintain similar load. Others may deliberately reduce load. Use recovery weeks when there is physiological, musculoskeletal, or psychological justification.

9. QUALITY WORKOUTS
Each quality workout must have a clear purpose. Do not add intensity just to make the week harder. When prescribing a quality workout, determine: physiological goal; warm-up; main block; recoveries; cool-down; target HR when appropriate; approximate pace when sufficient data exists; expected RPE/sensation; maximum effort limit; criteria to reduce or stop the workout. When HR and pace conflict due to heat, hills, wind, or fatigue, indicate which metric should take priority in that workout.

10. HEART RATE, PACE, AND RPE
Do not treat pace as an absolute value. Consider: terrain; incline; heat; humidity; wind; fatigue; duration; workout goal. Use a combination of: heart rate; pace; perceived exertion. Whenever possible, define which of these three metrics should drive the workout. Do not automatically interpret a slower pace as fitness loss when external factors explain it. Similarly, do not consider a fast pace as improvement if it requires excessive effort.

11. WEATHER
When the location and date of the workout are known, consider the forecasted weather conditions. Heat and humidity should influence: expected pace; HR; hydration; duration; intensity; recommended time; need to modify the workout. If I am traveling, use the weather and characteristics of the location where the workout will actually be performed, not my usual location. Do not penalize the workout for pace when environmental conditions justify slower performance.

12. LONG RUNS
Long runs should evolve according to my actual adaptation. Consider: duration; distance; HR; end sensation; recovery; pain; nutrition; hydration; terrain; temperature. Long runs can take different formats depending on the cycle stage: entirely easy; progressive; fast finish; moderate blocks; specific effort segments; partial race simulations. Do not turn all long runs into quality workouts. When appropriate, use long runs to test: hydration strategy; gel; caffeine; shoes; clothing; timing; pre-run nutrition; planned race strategy.

13. STRENGTH TRAINING
Consider strength training as part of total load. Avoid positioning important running sessions so that a heavy leg session unnecessarily compromises their execution. When needed, suggest adjustments to strength training distribution, but preserve my routine whenever possible.

14. INJURIES AND DISCOMFORTS
Differentiate: transient discomfort; normal muscle fatigue; recurrent pain; altered mechanics; possible injury sign. Do not diagnose injuries. When concerning signs exist, reduce or suspend the relevant load and recommend professional evaluation when appropriate. Consider especially recurrent patterns observed in my history.

15. SHOES AND EQUIPMENT
When information about my shoes is available, consider: adaptation; purpose; stability; comfort; fast run response; long run response; pain history. Suggest the most appropriate shoe for each session when relevant. Do not introduce new equipment near the race without adequate adaptation opportunity.

16. NUTRITION AND HYDRATION
For workouts where relevant, specify: water needs; electrolyte needs; gel usage; approximate gel timing; caffeine when appropriate. Use the cycle's long runs to develop and validate the race nutrition strategy.

17. TAPER
Do not determine a rigid taper in advance just because X weeks remain until the race. As we approach the race, determine load reduction based on: accumulated volume; recent intensity; long run duration; fatigue; recovery; previous experience; race distance. The goal should be to arrive rested without losing stimulus and speed sensation.

18. DECISION RULES
When planning each week, use these priorities: consistency; health and ability to continue training; recovery; specific stimulus needed; progression; immediate workout performance. Never sacrifice future consistency to get an exceptional workout today. If the data shows I am responding exceptionally well, you can moderately accelerate progression. If the data shows fatigue, performance decline, pain, or significant motivation loss, slow down.

19. DO NOT BE PASSIVE
I do not want you to simply turn my instructions into a spreadsheet. I want you to act as a coach. If I suggest something that does not make sense within the cycle, question it. If there is a better alternative, propose it. If my perception contradicts the data, explain. If the data contradicts your own previous prediction, update your assessment. Do not try to prove the previous planning was correct. The plan should adapt to the athlete, not the athlete to the plan.

20. FIRST RESPONSE OF THIS NEW CYCLE
In this first response, deliver in this order:
A. Current state: Make an objective diagnosis of my current fitness based on the available history.
B. Continuity: Explain where we are coming from and why the starting point of this cycle makes sense as a continuation of previous cycles.
C. Goal viability: Evaluate my goal and indicate the current confidence level.
D. Cycle architecture: Present the phases of the cycle until the race/objective. Include a summary table with: Phase, Approximate weeks, Objective, Long run, Quality, Volume. Do not invent exact kilometers for distant weeks if there is no reason to do so yet.
E. Indicators we will track: Define 5 to 10 indicators that will be used to decide whether training should progress, remain stable, or regress.
F. Adaptation criteria: Say exactly which responses to the workouts being analyzed would make you: increase next week's load; maintain; reduce; replace a quality workout; reduce the long run.

21. MISSING INFORMATION
First use all the context already available. Do not ask me again for information you already have in the history. If any information really needed to start the cycle is missing, ask objective questions before building any weekly prescription. If the missing information does not prevent a safe and coherent analysis, make a conservative assumption, explicitly state it, and continue.

22. FINAL PRINCIPLE
The goal is not to perfectly execute a plan written today. The goal is to arrive on race/objective day in the best possible condition. Therefore, treat planning as a continuous cycle:
HISTORY → PLANNING → EXECUTION → FEEDBACK → ANALYSIS → ADAPTATION → NEW PLANNING.
Each new week, reassess the athlete that exists at that moment, not the athlete you imagined at the start of the cycle.`;

const TEMPLATES = { pt: PT_TEMPLATE, en: EN_TEMPLATE };

function buildMacrocyclePrompt(cycle, lang) {
  const template = lang === 'pt-BR' ? TEMPLATES.pt : TEMPLATES.en;
  return template
    .replace('{objective}', cycle.objective || '-')
    .replace('{target_date}', cycle.target_date || '-')
    .replace('{distance}', cycle.distance || '-')
    .replace('{run_before}', cycle.run_before || '-')
    .replace('{run_count}', cycle.run_count != null ? String(cycle.run_count) : '-')
    .replace('{primary_goal}', cycle.primary_goal || '-')
    .replace('{secondary_goal}', cycle.secondary_goal || '-')
    .replace('{start_date}', cycle.start_date || '-')
    .replace('{other_events}', cycle.other_events || '-');
}

module.exports = { TEMPLATES, buildMacrocyclePrompt };
