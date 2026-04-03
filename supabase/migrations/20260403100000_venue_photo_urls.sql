-- Populate photo_url for all seeded venues
UPDATE venues SET photo_url = 'https://cdn.salarazzmatazz.com/web01/image-b7c1ba26ee0f7a3c7f8c11c833cdf5bc7c512efe-2279x1535-jpg-1875.webp'
WHERE name = 'Razzmatazz' AND city = 'Barcelona';

UPDATE venues SET photo_url = 'https://www.youbarcelona.com/uploads/images/clubs/pacha-barcelona/original.jpg'
WHERE name = 'Pacha Barcelona' AND city = 'Barcelona';

UPDATE venues SET photo_url = 'https://inputbcn.com/wp-content/uploads/2024/09/615A9324-1.jpg'
WHERE name = 'Input' AND city = 'Barcelona';

UPDATE venues SET photo_url = 'https://firebase.storage.googleapis.com/v0/b/project-7echno.appspot.com/o/venue%2Ffabrik.webp?alt=media'
WHERE name = 'Fabrik' AND city = 'Madrid';

UPDATE venues SET photo_url = 'https://images.discotech.me/venue/None/a094e3d9-4a4c-45e9-a676-8fd19a808296.jpg'
WHERE name = 'Mondo Disko' AND city = 'Madrid';

UPDATE venues SET photo_url = 'https://cdn.sanity.io/images/pge26oqu/production/7ed3f7db91394c4c7f54b05864edcc7d6bf5e0b6-275x183.jpg?rect=47,0,183,183&w=640&h=640'
WHERE name = 'Florida 135' AND city = 'Fraga';

UPDATE venues SET photo_url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/99/Amnesia_ibiza.jpeg/640px-Amnesia_ibiza.jpeg'
WHERE name = 'Amnesia Ibiza' AND city = 'Ibiza';

UPDATE venues SET photo_url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/38/Dc10_logo_with_black_background_and_white_text.jpg/640px-Dc10_logo_with_black_background_and_white_text.jpg'
WHERE name = 'DC-10' AND city = 'Ibiza';

UPDATE venues SET photo_url = 'https://djmag.com/sites/default/files/styles/djm_23_1005x565/public/2025-04/49.%20Crobar%20LY.jpg.webp?itok=-pGSsYJj'
WHERE name = 'Crobar' AND city = 'Buenos Aires';

UPDATE venues SET photo_url = 'https://www.gpsmycity.com/img/gd_sight/20761.jpg'
WHERE name = 'Bahrein' AND city = 'Buenos Aires';

UPDATE venues SET photo_url = 'https://www.mibsas.com/wp-content/uploads/2017/05/mandarine-park-800x450.jpg'
WHERE name = 'Mandarine Park' AND city = 'Buenos Aires';

UPDATE venues SET photo_url = 'https://www.night-aires.com/wp-content/uploads/2023/06/Club-Araoz-1.jpg'
WHERE name = 'Club Araoz' AND city = 'Buenos Aires';
