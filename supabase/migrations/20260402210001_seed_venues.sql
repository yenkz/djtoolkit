INSERT INTO venues (name, type, city, country, address, capacity, sqm, genres, mood_tags, dj_cabin_style, google_rating, target_profile) VALUES
-- Spain
('Razzmatazz', 'club', 'Barcelona', 'Spain', 'Carrer dels Almogàvers, 122', 3000, 5000, '{"techno","house","indie"}', '{"dark","energetic","underground"}', 'elevated booth', 4.3,
 '{"bpm":[125,140],"energy":[0.65,0.95],"danceability":[0.7,0.9]}'),
('Pacha Barcelona', 'club', 'Barcelona', 'Spain', 'Passeig Marítim de la Barceloneta, 38', 2500, 3000, '{"house","tech house","disco"}', '{"glamorous","upbeat","party"}', 'elevated booth', 4.1,
 '{"bpm":[120,132],"energy":[0.6,0.85],"danceability":[0.75,0.95]}'),
('Input', 'club', 'Barcelona', 'Spain', 'Av. Francesc Ferrer i Guàrdia, 13', 800, 1200, '{"techno","minimal","ambient"}', '{"dark","intimate","underground"}', 'floor level', 4.4,
 '{"bpm":[128,145],"energy":[0.7,0.95],"danceability":[0.65,0.85]}'),
('Fabrik', 'club', 'Madrid', 'Spain', 'Avda. de la Industria, 82', 4000, 8000, '{"techno","hard techno","trance"}', '{"industrial","intense","peak-time"}', 'elevated booth', 4.2,
 '{"bpm":[135,150],"energy":[0.8,1.0],"danceability":[0.7,0.9]}'),
('Mondo Disko', 'club', 'Madrid', 'Spain', 'C. de Alcalá, 20', 600, 800, '{"house","disco","nu-disco"}', '{"warm","groovy","intimate"}', 'floor level', 4.0,
 '{"bpm":[118,128],"energy":[0.5,0.75],"danceability":[0.8,0.95]}'),
('Florida 135', 'club', 'Fraga', 'Spain', 'Ctra. de Huesca, km 135', 5000, 10000, '{"techno","trance","hard dance"}', '{"massive","euphoric","peak-time"}', 'elevated booth', 4.3,
 '{"bpm":[135,150],"energy":[0.85,1.0],"danceability":[0.7,0.9]}'),
('Amnesia Ibiza', 'club', 'Ibiza', 'Spain', 'Carretera Ibiza a San Antonio, km 5', 5000, 6000, '{"house","techno","trance"}', '{"euphoric","legendary","peak-time"}', 'elevated booth', 4.5,
 '{"bpm":[125,140],"energy":[0.7,0.95],"danceability":[0.75,0.95]}'),
('DC-10', 'club', 'Ibiza', 'Spain', 'Ctra. de las Salinas, km 1', 1500, 2500, '{"techno","minimal","house"}', '{"raw","daytime","underground"}', 'floor level', 4.6,
 '{"bpm":[125,140],"energy":[0.6,0.9],"danceability":[0.7,0.9]}'),
-- Argentina
('Crobar', 'club', 'Buenos Aires', 'Argentina', 'Av. Paseo Colón 168', 1500, 2000, '{"techno","progressive","house"}', '{"dark","underground","intense"}', 'elevated booth', 4.1,
 '{"bpm":[125,140],"energy":[0.7,0.95],"danceability":[0.7,0.9]}'),
('Bahrein', 'club', 'Buenos Aires', 'Argentina', 'Lavalle 345', 1200, 1800, '{"techno","tech house","progressive"}', '{"underground","dark","industrial"}', 'elevated booth', 4.0,
 '{"bpm":[126,142],"energy":[0.7,0.95],"danceability":[0.65,0.85]}'),
('Mandarine Park', 'festival', 'Buenos Aires', 'Argentina', 'Costanera Norte', 10000, 30000, '{"techno","house","trance","progressive"}', '{"massive","outdoor","euphoric"}', 'elevated booth', 4.2,
 '{"bpm":[125,145],"energy":[0.7,1.0],"danceability":[0.7,0.95]}'),
('Club Araoz', 'club', 'Buenos Aires', 'Argentina', 'Araoz 2424', 500, 600, '{"house","deep house","disco"}', '{"intimate","warm","groovy"}', 'floor level', 4.3,
 '{"bpm":[118,128],"energy":[0.4,0.7],"danceability":[0.75,0.95]}');

-- Mood presets
INSERT INTO mood_presets (name, category, target_profile) VALUES
('Beach Sunset', 'beach', '{"bpm":[110,125],"energy":[0.3,0.6],"danceability":[0.6,0.8]}'),
('Beach Party', 'beach', '{"bpm":[118,130],"energy":[0.5,0.8],"danceability":[0.7,0.9]}'),
('Pool Party', 'pool_party', '{"bpm":[115,128],"energy":[0.5,0.75],"danceability":[0.75,0.95]}'),
('Pool Lounge', 'pool_party', '{"bpm":[105,120],"energy":[0.3,0.55],"danceability":[0.6,0.8]}'),
('Dark Nightclub', 'nightclub', '{"bpm":[128,145],"energy":[0.7,0.95],"danceability":[0.65,0.85]}'),
('Funky Nightclub', 'nightclub', '{"bpm":[120,132],"energy":[0.6,0.85],"danceability":[0.8,0.95]}'),
('Day Party', 'day_party', '{"bpm":[118,130],"energy":[0.5,0.8],"danceability":[0.7,0.9]}'),
('Rooftop Day', 'day_party', '{"bpm":[112,125],"energy":[0.4,0.65],"danceability":[0.65,0.85]}'),
('Coffee Rave', 'coffee_rave', '{"bpm":[130,145],"energy":[0.6,0.85],"danceability":[0.7,0.9]}'),
('Morning Rave', 'coffee_rave', '{"bpm":[125,138],"energy":[0.55,0.8],"danceability":[0.7,0.9]}'),
('Afterhours Deep', 'afterhours', '{"bpm":[120,132],"energy":[0.3,0.6],"danceability":[0.6,0.8]}'),
('Afterhours Hypnotic', 'afterhours', '{"bpm":[128,140],"energy":[0.5,0.75],"danceability":[0.6,0.8]}');
