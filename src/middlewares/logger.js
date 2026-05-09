import morgan from "morgan";

const isDev = process.env.NODE_ENV === "development";

const logger = isDev
  ? morgan("dev")
  : morgan("combined", {
      skip: (req, res) => res.statusCode < 400,
    });

export default logger;
